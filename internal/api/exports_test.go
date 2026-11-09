package api

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/blob/blobtest"
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/source"
	"github.com/supazd/supabi/internal/store"
	"github.com/supazd/supabi/internal/worker"
)

func testExportWorker(c *client) *worker.Worker {
	return testExportWorkerWith(c, blob.NewLocal(filepath.Join(c.dataDir, "exports")))
}

// testExportWorkerWith keeps export files in files.
func testExportWorkerWith(c *client, files blob.Store) *worker.Worker {
	s := c.api
	service := &exports.Service{Pool: s.Pool, Files: files, Sources: source.Connections{Pool: s.Pool, Secrets: s.Secrets, Conns: s.Conns}}
	service.Charts = s
	s.Exports = service
	return &worker.Worker{Pool: s.Pool, Exports: service, Logger: s.Logger, Concurrency: 2, Audit: s.Audit}
}

// setExportLimits sets the system settings as an administrator would.
func setExportLimits(t *testing.T, c *client, v store.SystemSettingValues) {
	t.Helper()
	if err := store.SetSystemSettings(context.Background(), c.db.Pool, store.Scope{OrgID: store.DefaultOrgID}, v); err != nil {
		t.Fatal(err)
	}
}

func queueExport(c *client, sourceID, format, sql string) string {
	return c.expect("POST", "/exports", map[string]any{"datasourceId": sourceID, "format": format, "sql": sql, "name": "中文导出"}, 202, "")["id"].(string)
}

func processExport(t *testing.T, w *worker.Worker) store.Job {
	t.Helper()
	j, err := store.ClaimJob(context.Background(), w.Pool)
	if err != nil {
		t.Fatal(err)
	}
	w.Process(context.Background(), j)
	return j
}

func TestBackgroundExportsDownloadFullResultsAndNotify(t *testing.T) {
	blobtest.Each(t, testExportsDownloadFullResultsAndNotify)
}

func testExportsDownloadFullResultsAndNotify(t *testing.T, files blob.Store) {
	for _, format := range []string{"csv", "xlsx"} {
		t.Run(format, func(t *testing.T) {
			c := newClient(t)
			w := testExportWorkerWith(c, files)
			ctx := context.Background()
			sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
			sql := `SELECT n AS "行号", 123456789012345678::bigint AS "编号", 123456789012345678.123456::numeric AS "金额", '=1+1'::text AS "文本", '2026-10-18'::date AS "日期" FROM generate_series(1, {{count}}) n`
			input := map[string]any{"datasourceId": sourceID, "format": format, "sql": sql, "name": "中文导出", "params": []any{map[string]any{"name": "count", "type": "integer", "required": true, "default": 2001}}}
			created := c.expect("POST", "/exports", input, 202, "")
			id := created["id"].(string)
			c.expect("GET", "/exports/"+id+"/file", nil, 409, "export_not_ready")
			// Closing/logging out of the originating session must not stop work.
			c.expect("POST", "/auth/logout", nil, 204, "")
			job := processExport(t, w)
			c = c.signedIn(adminEmail, adminPassword)
			result := c.expect("GET", "/exports/"+id, nil, 200, "")
			if result["status"] != "succeeded" || result["rows"] != float64(2001) || result["sizeBytes"].(float64) <= 0 {
				t.Fatalf("export: %v", result)
			}
			response, err := c.http.Get(c.server.URL + "/api/v1/exports/" + id + "/file")
			if err != nil {
				t.Fatal(err)
			}
			raw, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 200 || response.Header.Get("Cache-Control") != "private, no-store" || !strings.Contains(response.Header.Get("Content-Disposition"), "attachment") {
				t.Fatalf("download: %v", response)
			}
			// A resumed download gets the rest of the same file.
			resume, _ := http.NewRequest("GET", c.server.URL+"/api/v1/exports/"+id+"/file", nil)
			resume.Header.Set("Range", "bytes=100-")
			response, err = c.http.Do(resume)
			if err != nil {
				t.Fatal(err)
			}
			rest, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != 206 || !bytes.Equal(rest, raw[100:]) {
				t.Fatalf("resumed download: %d, %d bytes of %d, %v", response.StatusCode, len(rest), len(raw)-100, err)
			}
			if format == "csv" {
				rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(raw), "\ufeff"))).ReadAll()
				if err != nil {
					t.Fatal(err)
				}
				if len(rows) != 2002 || rows[1][1] != "123456789012345678" || rows[1][2] != "123456789012345678.123456" || rows[1][3] != "'=1+1" {
					t.Fatalf("CSV rows/value mismatch: %d %v", len(rows), rows[1])
				}
			} else {
				z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, file := range z.File {
					if file.Name == "xl/worksheets/sheet1.xml" {
						r, _ := file.Open()
						b, _ := io.ReadAll(r)
						_ = r.Close()
						found = true
						if strings.Count(string(b), "<row ") != 2002 || !strings.Contains(string(b), "123456789012345678.123456") {
							t.Fatal("XLSX rows/precision mismatch")
						}
					}
				}
				if !found {
					t.Fatal("not an XLSX workbook")
				}
			}
			page := c.expect("GET", "/exports", nil, 200, "")
			if page["unseen"] != float64(1) {
				t.Fatalf("new result: %v", page)
			}
			item := page["items"].([]any)[0].(map[string]any)
			if item["id"] != id || item["unseen"] != true || item["source"] != "sql" || item["denied"] != nil {
				t.Fatalf("wrong result: %v", item)
			}
			if _, err := store.FinishJob(ctx, w.Pool, job, store.ExportFile{}, ""); !errors.Is(err, store.ErrNotFound) {
				t.Fatalf("duplicate finish: %v", err)
			}
			c.expect("POST", "/exports/seen", nil, 204, "")
			if page := c.expect("GET", "/exports", nil, 200, ""); page["unseen"] != float64(0) || page["items"].([]any)[0].(map[string]any)["unseen"] != false {
				t.Fatal("seen not persisted")
			}
			var key string
			if err := w.Pool.QueryRow(ctx, `SELECT file_key FROM exports WHERE id=$1`, id).Scan(&key); err != nil {
				t.Fatal(err)
			}
			if _, err := files.Open(ctx, key); err != nil {
				t.Fatalf("published file: %v", err)
			}
			if _, err := w.Pool.Exec(ctx, `UPDATE exports SET expires_at=now()-interval '1 second' WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			c.expect("GET", "/exports/"+id+"/file", nil, 410, "export_expired")
			if err := w.Exports.Cleanup(ctx, store.DefaultOrgID); err != nil {
				t.Fatal(err)
			}
			if _, err := files.Open(ctx, key); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("expired file remains: %v", err)
			}
			if c.expect("GET", "/exports/"+id, nil, 200, "")["status"] != "expired" {
				t.Fatal("expiry not visible")
			}
		})
	}
}

// A cancelled export discards what it had written: on S3, a multipart
// upload already under way.
func TestExportCancelledWhileWritingLeavesNoFile(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		c := newClient(t)
		w := testExportWorkerWith(c, files)
		ctx := context.Background()
		sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
		// About 6 MB, more than a part, before the last row stalls.
		id := queueExport(c, sourceID, "csv", `SELECT n, repeat('x', 1000) || CASE WHEN n = 6000 THEN pg_sleep(20)::text ELSE '' END AS filler FROM generate_series(1, 6000) n`)
		j, err := store.ClaimJob(ctx, w.Pool)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() { defer close(done); w.Process(ctx, j) }()
		for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(100 * time.Millisecond) {
			var rows int64
			if err := w.Pool.QueryRow(ctx, `SELECT row_count FROM exports WHERE id=$1`, id).Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows >= 5400 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("only %d rows written", rows)
			}
		}
		if keys := blobtest.Keys(t, files, ""); len(keys) != 1 {
			t.Fatalf("not one file being written: %v", keys)
		}
		c.expect("POST", "/exports/"+id+"/cancel", nil, 204, "")
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			t.Fatal("running export was not cancelled")
		}
		if status := c.expect("GET", "/exports/"+id, nil, 200, "")["status"]; status != "cancelled" {
			t.Fatalf("status %v", status)
		}
		if keys := blobtest.Keys(t, files, ""); len(keys) != 0 {
			t.Fatalf("left behind: %v", keys)
		}
	})
}

func TestExportOwnershipAndRevokedPermissions(t *testing.T) {
	f := newContentFixture(t)
	w := testExportWorker(f.admin)
	sourceID := f.sourceID(t)
	done := queueExport(f.developer, sourceID, "csv", "SELECT 1 AS n")
	processExport(t, w)
	id := queueExport(f.developer, sourceID, "csv", "SELECT 1 AS n")
	for _, path := range []string{"/exports/" + id, "/exports/" + id + "/file"} {
		f.admin.expect("GET", path, nil, 404, "not_found")
		f.viewer.expect("GET", path, nil, 404, "not_found")
	}
	f.admin.expect("POST", "/exports/"+id+"/cancel", nil, 404, "not_found")
	f.viewer.expect("POST", "/exports/"+id+"/cancel", nil, 404, "not_found")
	if len(f.admin.expect("GET", "/exports", nil, 200, "")["items"].([]any)) != 0 || len(f.viewer.expect("GET", "/exports", nil, 200, "")["items"].([]any)) != 0 {
		t.Fatal("another user's exports leaked")
	}
	f.viewer.expect("POST", "/exports", map[string]any{"datasourceId": sourceID, "format": "csv", "sql": "SELECT 1", "name": "viewer"}, 403, "forbidden")
	user := userID(t, f.admin, "developer@example.com")
	f.admin.expect("PATCH", "/members/"+user, map[string]any{"role": "viewer"}, 200, "")
	processExport(t, w)
	var status, code string
	if err := w.Pool.QueryRow(context.Background(), `SELECT status,error_code FROM background_jobs WHERE id=$1`, id).Scan(&status, &code); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || code != "export_forbidden" {
		t.Fatalf("revoked user ran export: %s %s", status, code)
	}
	f.developer.expect("GET", "/exports/"+id+"/file", nil, 409, "export_not_ready")
	// A file made before the downgrade stays listed, but SQL results are
	// for developers only.
	f.developer.expect("GET", "/exports/"+done+"/file", nil, 403, "export_role")
	// A role downgrade must not hide the owner's results.
	page := f.developer.expect("GET", "/exports", nil, 200, "")
	items := page["items"].([]any)
	if page["unseen"] != float64(2) || len(items) != 2 {
		t.Fatalf("revoked owner's exports: %v", page)
	}
	failed, succeeded := items[0].(map[string]any), items[1].(map[string]any)
	if failed["id"] != id || failed["status"] != "failed" || failed["unseen"] != true || succeeded["id"] != done || succeeded["denied"] != "export_role" {
		t.Fatalf("revoked owner's results: %v", items)
	}
	f.viewer.expect("POST", "/exports/seen", nil, 204, "")
	if f.developer.expect("GET", "/exports", nil, 200, "")["unseen"] != float64(2) {
		t.Fatal("another user saw the owner's results")
	}
}

// The export center holds the owner's exports from every workspace they can
// enter, each checked in its own: .agents/design/exports.md 6.
func TestExportCenterSpansWorkspaces(t *testing.T) {
	f := newContentFixture(t)
	w := testExportWorker(f.admin)
	sourceID := f.sourceID(t)
	first := f.admin.expect("GET", "/auth/session", nil, 200, "")["workspace"].(map[string]any)
	done := queueExport(f.developer, sourceID, "csv", "SELECT 1 AS n")
	processExport(t, w)
	queued := queueExport(f.developer, sourceID, "csv", "SELECT 2 AS n")
	own := queueExport(f.admin, sourceID, "csv", "SELECT 3 AS n")

	// The developer is only a viewer in a second workspace, and works there.
	other := f.admin.expect("POST", "/workspaces", map[string]any{"name": "Other", "timezone": "UTC", "weekStart": 1}, 201, "")
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": other["id"]}, 200, "")
	developer := userID(t, f.admin, "developer@example.com")
	f.admin.expect("POST", "/members", map[string]any{"userId": developer, "role": "viewer"}, 201, "")
	f.developer.expect("POST", "/auth/workspace", map[string]any{"workspaceId": other["id"]}, 200, "")

	page := f.developer.expect("GET", "/exports", nil, 200, "")
	items := page["items"].([]any)
	if len(items) != 2 || page["unseen"] != float64(1) {
		t.Fatalf("exports from another workspace: %v", page)
	}
	for _, item := range items {
		e := item.(map[string]any)
		if e["workspaceId"] != first["id"] || e["workspaceName"] != first["name"] || e["denied"] != nil {
			t.Fatalf("export of the first workspace: %v", e)
		}
	}
	// A SQL export is for developers, and the developer is one where it was made.
	got := f.developer.expect("GET", "/exports/"+done, nil, 200, "")
	if got["status"] != "succeeded" || got["workspaceName"] != first["name"] {
		t.Fatalf("export: %v", got)
	}
	response, err := f.developer.http.Get(f.developer.server.URL + "/api/v1/exports/" + done + "/file")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("download from another workspace: %d", response.StatusCode)
	}
	f.developer.expect("POST", "/exports/"+queued+"/cancel", nil, 204, "")
	f.developer.expect("POST", "/exports/seen", nil, 204, "")
	if f.developer.expect("GET", "/exports", nil, 200, "")["unseen"] != float64(0) {
		t.Fatal("new results stayed new after being seen")
	}
	// Both are recorded where the export was made, not where its owner was.
	for _, action := range []string{"export.download", "export.cancel"} {
		var workspace string
		if err := f.admin.db.Pool.QueryRow(context.Background(), `SELECT workspace_id FROM audit_events WHERE action=$1 AND outcome='success' ORDER BY occurred_at DESC LIMIT 1`, action).Scan(&workspace); err != nil {
			t.Fatal(err)
		}
		if workspace != first["id"] {
			t.Fatalf("%s recorded in %q", action, workspace)
		}
	}
	// The admin, working in the second workspace too, still has theirs.
	if items := f.admin.expect("GET", "/exports", nil, 200, "")["items"].([]any); len(items) != 1 || items[0].(map[string]any)["id"] != own {
		t.Fatalf("admin's exports from another workspace: %v", items)
	}

	// Once the developer cannot enter the first workspace, its exports are gone.
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": first["id"]}, 200, "")
	f.admin.expect("DELETE", "/members/"+developer, nil, 204, "")
	if items := f.developer.expect("GET", "/exports", nil, 200, "")["items"].([]any); len(items) != 0 {
		t.Fatalf("exports of a workspace left: %v", items)
	}
	f.developer.expect("GET", "/exports/"+done, nil, 404, "not_found")
	f.developer.expect("GET", "/exports/"+done+"/file", nil, 404, "not_found")
	f.developer.expect("POST", "/exports/"+queued+"/cancel", nil, 404, "not_found")

	// So are those of a deleted workspace, even for a system administrator.
	f.admin.expect("DELETE", "/workspaces/"+first["id"].(string), nil, 200, "")
	if items := f.admin.expect("GET", "/exports", nil, 200, "")["items"].([]any); len(items) != 0 {
		t.Fatalf("exports of a deleted workspace: %v", items)
	}
	f.admin.expect("GET", "/exports/"+own, nil, 404, "not_found")
}

func TestExportUsesSubmittedTimezoneAndCreationDate(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	ctx := context.Background()
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	if _, err := w.Pool.Exec(ctx, `UPDATE workspaces SET timezone='Asia/Shanghai'`); err != nil {
		t.Fatal(err)
	}
	created := c.expect("POST", "/exports", map[string]any{
		"datasourceId": sourceID, "format": "csv", "name": "timezone",
		"sql":    `SELECT {{day}}::date AS day, '2026-10-18 09:00:00'::timestamp AS local_time, '2026-10-18 00:00:00+00'::timestamptz AS instant`,
		"params": []any{map[string]any{"name": "day", "type": "date", "required": true, "default": map[string]any{"relative": "today"}}},
	}, 202, "")
	id := created["id"].(string)
	// A delayed/recovered job uses the submitted workspace zone and creation
	// date, even if the administrator changes that zone while it is queued.
	if _, err := w.Pool.Exec(ctx, `UPDATE workspaces SET timezone='UTC'`); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Pool.Exec(ctx, `UPDATE background_jobs SET created_at='2026-10-18 20:00:00+00' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	processExport(t, w)
	response, err := c.http.Get(c.server.URL + "/api/v1/exports/" + id + "/file")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !strings.Contains(string(raw), "2026-10-19,2026-10-18T09:00:00,2026-10-18T08:00:00") {
		t.Fatalf("wrong timezone/date: %d %s", response.StatusCode, raw)
	}
}

func TestExportPreservesDuplicateColumnsWithTimestamps(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	for _, format := range []string{"csv", "xlsx"} {
		t.Run(format, func(t *testing.T) {
			id := queueExport(c, sourceID, format, `SELECT 1 AS id, 2 AS id, timestamp '2026-10-18 09:00:00' AS at, timestamp '2026-10-18 10:00:00' AS at`)
			processExport(t, w)
			response, err := c.http.Get(c.server.URL + "/api/v1/exports/" + id + "/file")
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			raw, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 200 {
				t.Fatalf("download: %d %s", response.StatusCode, raw)
			}
			if format == "csv" {
				want := "\ufeffid,id,at,at\n1,2,2026-10-18T01:00:00,2026-10-18T02:00:00\n"
				if string(raw) != want {
					t.Fatalf("columns or values changed: %s", raw)
				}
				return
			}
			z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
			if err != nil {
				t.Fatal(err)
			}
			for _, file := range z.File {
				if file.Name != "xl/worksheets/sheet1.xml" {
					continue
				}
				r, _ := file.Open()
				sheet, _ := io.ReadAll(r)
				_ = r.Close()
				for _, want := range []string{`r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">id`, `r="B1" s="1" t="inlineStr"><is><t xml:space="preserve">id`, `r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">at`, `r="D1" s="1" t="inlineStr"><is><t xml:space="preserve">at`, `r="A2" s="0" t="n"><v>1</v>`, `r="B2" s="0" t="n"><v>2</v>`, `r="C2" s="3" t="n"><v>46313.0416666667</v>`, `r="D2" s="3" t="n"><v>46313.0833333333</v>`} {
					if !strings.Contains(string(sheet), want) {
						t.Fatalf("missing %s in worksheet: %s", want, sheet)
					}
				}
				return
			}
			t.Fatal("workbook has no worksheet")
		})
	}
}

func TestExportCancellationLimitsAndFailure(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	ctx := context.Background()
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	id := queueExport(c, sourceID, "csv", "SELECT 1 AS n")
	c.expect("POST", "/exports/"+id+"/cancel", nil, 204, "")
	if _, err := store.ClaimJob(ctx, w.Pool); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cancelled queued job claimed: %v", err)
	}
	id = queueExport(c, sourceID, "xlsx", "SELECT pg_sleep(20) AS wait")
	j, err := store.ClaimJob(ctx, w.Pool)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { defer close(done); w.Process(ctx, j) }()
	c.expect("POST", "/exports/"+id+"/cancel", nil, 204, "")
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("running query was not cancelled")
	}
	if c.expect("GET", "/exports/"+id, nil, 200, "")["status"] != "cancelled" {
		t.Fatal("cancellation not terminal")
	}
	// The limit an attempt keeps to is the one set when it began.
	oneRow := int64(1)
	setExportLimits(t, c, store.SystemSettingValues{ExportMaxRows: &oneRow})
	id = queueExport(c, sourceID, "csv", "SELECT n FROM generate_series(1,2) n")
	processExport(t, w)
	result := c.expect("GET", "/exports/"+id, nil, 200, "")
	if result["errorCode"] != "export_row_limit" || result["sizeBytes"] != float64(0) {
		t.Fatalf("oversized export: %v", result)
	}
	if page := c.expect("GET", "/exports", nil, 200, ""); page["maxRows"] != float64(1) {
		t.Errorf("the export centre says at most %v rows", page["maxRows"])
	}
	setExportLimits(t, c, store.SystemSettingValues{})
	c.expect("GET", "/exports/"+id+"/file", nil, 409, "export_not_ready")
	id = queueExport(c, sourceID, "csv", "SELECT * FROM no_such_export_table")
	processExport(t, w)
	if c.expect("GET", "/exports/"+id, nil, 200, "")["errorCode"] != "export_query_failed" {
		t.Fatal("SQL failure not reported")
	}
	for range 5 {
		queueExport(c, sourceID, "csv", "SELECT 1")
	}
	c.expect("POST", "/exports", map[string]any{"datasourceId": sourceID, "format": "csv", "sql": "SELECT 1", "name": "over quota"}, 429, "export_queue_full")
}

func TestExportLeaseRecoveryAndSchedulerDeduplication(t *testing.T) {
	c := newClient(t)
	w := testExportWorker(c)
	ctx := context.Background()
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	id := queueExport(c, sourceID, "csv", "SELECT 1 AS n")
	old, err := store.ClaimJob(ctx, w.Pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.ClaimJob(ctx, w.Pool); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("live lease claimed twice: %v", err)
	}
	if _, err = w.Pool.Exec(ctx, `UPDATE background_jobs SET lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	fresh, err := store.ClaimJob(ctx, w.Pool)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.LeaseToken == old.LeaseToken || fresh.Attempts != 2 {
		t.Fatal("not reclaimed with a new lease")
	}
	if _, err = store.FinishJob(ctx, w.Pool, old, store.ExportFile{}, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatal("stale worker published")
	}
	w.Process(ctx, fresh)
	if c.expect("GET", "/exports/"+id, nil, 200, "")["status"] != "succeeded" {
		t.Fatal("recovered job failed")
	}
	id = queueExport(c, sourceID, "csv", "SELECT 1")
	_, err = store.ClaimJob(ctx, w.Pool)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = w.Pool.Exec(ctx, `UPDATE background_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	_, _ = store.ClaimJob(ctx, w.Pool)
	if c.expect("GET", "/exports/"+id, nil, 200, "")["errorCode"] != "export_interrupted" {
		t.Fatal("exhausted job not failed")
	}
	// An org that never exported gets no cleanup job.
	if _, err = w.Pool.Exec(ctx, `INSERT INTO orgs(id,name) VALUES('org_without_exports','idle')`); err != nil {
		t.Fatal(err)
	}
	hour := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	for _, at := range []time.Time{hour, hour.Add(time.Minute), hour.Add(59 * time.Minute)} {
		if err := store.EnqueueExportCleanup(ctx, w.Pool, at); err != nil {
			t.Fatal(err)
		}
	}
	cleanups := func() (n int) {
		t.Helper()
		if err := w.Pool.QueryRow(ctx, `SELECT count(*) FROM background_jobs WHERE kind='export_cleanup'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := cleanups(); n != 1 {
		t.Fatalf("%d cleanups scheduled within one hour", n)
	}
	processExport(t, w)
	var status string
	if err := w.Pool.QueryRow(ctx, `SELECT status FROM background_jobs WHERE kind='export_cleanup'`).Scan(&status); err != nil || status != "succeeded" {
		t.Fatal(fmt.Sprint("cleanup: ", status, err))
	}
	if err := store.EnqueueExportCleanup(ctx, w.Pool, hour.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if n := cleanups(); n != 2 {
		t.Fatalf("%d cleanups after the next hour", n)
	}
}
