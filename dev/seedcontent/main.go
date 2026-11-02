// Command seedcontent fills SupaBI with sample content over the PostgreSQL
// sample data of `make dev-seed`: a data source, datasets, charts and
// dashboards, as `make dev-seed-content` does. It needs no running server
// and no password: it signs the earliest organisation administrator in for
// the length of the run and calls the API in process, so everything it
// creates passes the checks it would pass from the browser.
//
// What it creates is named with the prefix 「示例 · 」, and the data source
// 「示例 PostgreSQL」; it is put in a folder 示例 of each kind, in the
// administrator's first workspace. A run first deletes what an earlier run
// created, by those names, so changing content.json and running again
// gives the new content. It stops, deleting nothing more, when something of
// someone else's uses what it would delete.
package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/postgres" // registers the driver
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
)

//go:embed content.json
var contentJSON []byte

const (
	prefix         = "示例 · "
	datasourceName = "示例 PostgreSQL"
	folderName     = "示例"
)

type resource struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Spec        json.RawMessage `json:"spec"`
}

type content struct {
	Datasets   []resource `json:"datasets"`
	Charts     []resource `json:"charts"`
	Dashboards []resource `json:"dashboards"`
}

func main() {
	databaseURL := flag.String("database-url", "postgres://supabi:supabi@127.0.0.1:15432/supabi", "SupaBI's metadata database")
	secretKey := flag.String("secret-key", os.Getenv("SUPABI_SECRET_KEY"), "the server's secret-key, which encrypts the data source's password; also SUPABI_SECRET_KEY")
	demoURL := flag.String("demo-url", "postgres://supabi_demo:demo@127.0.0.1:15432/supabi", "where the server reaches the sample data, as the data source to create")
	flag.Parse()
	if err := run(context.Background(), *databaseURL, *secretKey, *demoURL); err != nil {
		fmt.Fprintln(os.Stderr, "seedcontent:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, databaseURL, secretKey, demoURL string) error {
	var c content
	if err := json.Unmarshal(contentJSON, &c); err != nil {
		return fmt.Errorf("content.json: %w", err)
	}
	if secretKey == "" {
		return errors.New("the server's secret-key is needed, to encrypt the data source's password: set -secret-key or SUPABI_SECRET_KEY")
	}
	secrets, err := secret.NewBox(secretKey)
	if err != nil {
		return err
	}
	demo, err := url.Parse(demoURL)
	if err != nil {
		return fmt.Errorf("-demo-url: %w", err)
	}
	pool, err := store.Open(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer pool.Close()
	// A password sealed with another key than the server's could not be read.
	if err := store.CheckSecretKey(ctx, pool, secrets); err != nil {
		return err
	}

	var admin store.User
	err = pool.QueryRow(ctx, `SELECT id, org_id FROM users WHERE is_org_admin AND status = 'active' ORDER BY created_at, id LIMIT 1`).Scan(&admin.ID, &admin.OrgID)
	if err != nil {
		return fmt.Errorf("find an administrator to act as; open SupaBI and create one first: %w", err)
	}
	admin.IsOrgAdmin = true
	token, hash := auth.NewSessionToken()
	if err := store.CreateSession(ctx, pool, admin, hash, time.Hour); err != nil {
		return err
	}
	defer store.DeleteSession(context.Background(), pool, hash)

	conns := datasource.NewManager()
	defer conns.Close()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	server := &api.Server{
		Pool: pool, Secrets: secrets, Conns: conns, Logger: logger,
		Cache: qcache.New(nil, logger),
		// What it does is recorded as the administrator's, like anything else.
		Audit: store.AuditEvents{Pool: pool},
	}
	mux := http.NewServeMux()
	server.Register(mux)
	cl := client{mux: mux, token: token}

	if err := cl.removeEarlier(); err != nil {
		return err
	}
	folders, err := cl.folders()
	if err != nil {
		return err
	}

	password, _ := demo.User.Password()
	ds, err := cl.call("POST", "/datasources", map[string]any{
		"name": datasourceName, "type": "postgres", "password": password, "dataTimezone": "Asia/Shanghai",
		"settings": map[string]string{"host": demo.Hostname(), "port": demo.Port(), "database": strings.TrimPrefix(demo.Path, "/"), "user": demo.User.Username(), "sslmode": "disable"},
	}, http.StatusCreated)
	if err != nil {
		return fmt.Errorf("create the data source: %w", err)
	}
	refs := map[string]string{}
	create := func(kind, path string, r resource, extra map[string]any) (string, error) {
		spec, err := resolve(r.Spec, refs)
		if err != nil {
			return "", fmt.Errorf("%s %q: %w", kind, r.Name, err)
		}
		body := map[string]any{"name": prefix + r.Name, "description": r.Description, "spec": spec}
		for k, v := range extra {
			body[k] = v
		}
		created, err := cl.call("POST", path, body, http.StatusCreated)
		if err != nil {
			return "", fmt.Errorf("create %s %q: %w", kind, r.Name, err)
		}
		id := created["id"].(string)
		if _, err := cl.call("POST", "/folders/move", map[string]any{"kind": kind, "id": id, "folderId": folders[kind]}, http.StatusNoContent); err != nil {
			return "", fmt.Errorf("put %s %q in its folder: %w", kind, r.Name, err)
		}
		refs["@"+kind+"/"+r.Name] = id
		return id, nil
	}
	for _, r := range c.Datasets {
		if _, err := create("dataset", "/datasets", r, map[string]any{"datasourceId": ds["id"]}); err != nil {
			return err
		}
	}
	var charts []string
	for _, r := range c.Charts {
		id, err := create("chart", "/charts", r, nil)
		if err != nil {
			return err
		}
		charts = append(charts, id)
	}
	for _, r := range c.Dashboards {
		if _, err := create("dashboard", "/dashboards", r, nil); err != nil {
			return err
		}
	}

	// Each chart's data, alone and on its dashboards with their defaults; a
	// chart that drills also one level down, into the value of its first row.
	var failed []string
	for i, id := range charts {
		result, err := cl.call("POST", "/charts/"+id+"/data", map[string]any{}, http.StatusOK)
		if err != nil {
			failed = append(failed, fmt.Sprintf("chart %q: %v", c.Charts[i].Name, err))
			continue
		}
		if value, ok := firstDrilled(c.Charts[i].Spec, result); ok {
			if _, err := cl.call("POST", "/charts/"+id+"/data", map[string]any{"drill": []any{value}}, http.StatusOK); err != nil {
				failed = append(failed, fmt.Sprintf("chart %q, drilled into %v: %v", c.Charts[i].Name, value, err))
			}
		}
	}
	for _, r := range c.Dashboards {
		id := refs["@dashboard/"+r.Name]
		var spec struct {
			Layout struct {
				Items []struct {
					ID   string `json:"id"`
					Type string `json:"type"`
					Tabs []struct {
						ID string `json:"id"`
					} `json:"tabs"`
				} `json:"items"`
			} `json:"layout"`
		}
		if err := json.Unmarshal(r.Spec, &spec); err != nil {
			return err
		}
		for _, item := range spec.Layout.Items {
			ids := []string{item.ID}
			if item.Type == "tabs" {
				ids = ids[:0]
				for _, tab := range item.Tabs {
					ids = append(ids, tab.ID)
				}
			} else if item.Type != "chart" {
				continue
			}
			for _, itemID := range ids {
				if _, err := cl.call("POST", "/dashboards/"+id+"/items/"+itemID+"/data", map[string]any{}, http.StatusOK); err != nil {
					failed = append(failed, fmt.Sprintf("dashboard %q, widget %s: %v", r.Name, itemID, err))
				}
			}
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("created, but some charts cannot show their data:\n  %s", strings.Join(failed, "\n  "))
	}
	fmt.Printf("Created the data source %s, %d datasets, %d charts and %d dashboards in the folders %s; every chart shows its data, and every drill its next level.\n",
		datasourceName, len(c.Datasets), len(c.Charts), len(c.Dashboards), folderName)
	var timezone string
	if err := pool.QueryRow(ctx, `SELECT w.timezone FROM sessions s JOIN workspaces w ON w.id = s.workspace_id WHERE s.token_hash = $1`, hash).Scan(&timezone); err == nil && timezone != "Asia/Shanghai" {
		fmt.Printf("Note: the workspace's time zone is %s, but the sample data is Shanghai time, so times of day are shown shifted. Set the workspace's time zone to Asia/Shanghai in its settings to see them as written.\n", timezone)
	}
	return nil
}

// firstDrilled is the value of the drilled column in the first row of a
// chart's result, if the chart drills and has a row.
func firstDrilled(spec json.RawMessage, result map[string]any) (any, bool) {
	var s struct {
		Drill *struct {
			Alias string `json:"alias"`
		} `json:"drill"`
	}
	if json.Unmarshal(spec, &s) != nil || s.Drill == nil {
		return nil, false
	}
	columns, _ := result["columns"].([]any)
	rows, _ := result["rows"].([]any)
	if len(rows) == 0 {
		return nil, false
	}
	row, _ := rows[0].([]any)
	for i, column := range columns {
		if c, _ := column.(map[string]any); c["name"] == s.Drill.Alias && i < len(row) {
			return row[i], true
		}
	}
	return nil, false
}

// resolve replaces each "@dataset/name" and "@chart/name" in a spec with the
// ID of what was created by that name.
func resolve(raw json.RawMessage, refs map[string]string) (any, error) {
	var spec any
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil, err
	}
	var walk func(v any) (any, error)
	walk = func(v any) (any, error) {
		switch v := v.(type) {
		case string:
			if strings.HasPrefix(v, "@dataset/") || strings.HasPrefix(v, "@chart/") {
				id, ok := refs[v]
				if !ok {
					return nil, fmt.Errorf("%s is not created before it", v)
				}
				return id, nil
			}
		case []any:
			for i := range v {
				var err error
				if v[i], err = walk(v[i]); err != nil {
					return nil, err
				}
			}
		case map[string]any:
			for k := range v {
				var err error
				if v[k], err = walk(v[k]); err != nil {
					return nil, err
				}
			}
		}
		return v, nil
	}
	return walk(spec)
}

// removeEarlier deletes what an earlier run created, users of a thing first.
func (cl client) removeEarlier() error {
	for _, kind := range []string{"dashboards", "charts", "datasets", "datasources"} {
		list, err := cl.list("/" + kind)
		if err != nil {
			return err
		}
		for _, r := range list {
			name, _ := r["name"].(string)
			if kind == "datasources" && name != datasourceName || kind != "datasources" && !strings.HasPrefix(name, prefix) {
				continue
			}
			if _, err := cl.call("DELETE", "/"+kind+"/"+r["id"].(string), nil, http.StatusNoContent); err != nil {
				return fmt.Errorf("delete %q of an earlier run: %w; change or delete what uses it, and run again", name, err)
			}
		}
	}
	return nil
}

// folders finds or creates the top-level folder 示例 of each kind.
func (cl client) folders() (map[string]string, error) {
	list, err := cl.list("/folders")
	if err != nil {
		return nil, err
	}
	ids := map[string]string{}
	for _, f := range list {
		if f["name"] == folderName && f["parentId"] == nil {
			ids[f["kind"].(string)] = f["id"].(string)
		}
	}
	for _, kind := range []string{"dataset", "chart", "dashboard"} {
		if ids[kind] != "" {
			continue
		}
		created, err := cl.call("POST", "/folders", map[string]any{"name": folderName, "kind": kind}, http.StatusCreated)
		if err != nil {
			return nil, fmt.Errorf("create the %s folder: %w", kind, err)
		}
		ids[kind] = created["id"].(string)
	}
	return ids, nil
}

// client calls the API in process, signed in as the administrator.
type client struct {
	mux   *http.ServeMux
	token string
}

func (cl client) send(method, path string, body any, want int) ([]byte, error) {
	var reader io.Reader = http.NoBody
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, "/api/v1"+path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: "supabi_session", Value: cl.token})
	rec := httptest.NewRecorder()
	cl.mux.ServeHTTP(rec, req)
	if rec.Code != want {
		var e struct{ Code, Message string }
		_ = json.Unmarshal(rec.Body.Bytes(), &e)
		return nil, fmt.Errorf("%s %s: %d %s: %s", method, path, rec.Code, e.Code, e.Message)
	}
	return rec.Body.Bytes(), nil
}

func (cl client) call(method, path string, body any, want int) (map[string]any, error) {
	raw, err := cl.send(method, path, body, want)
	if err != nil || len(raw) == 0 {
		return nil, err
	}
	var out map[string]any
	return out, json.Unmarshal(raw, &out)
}

func (cl client) list(path string) ([]map[string]any, error) {
	raw, err := cl.send("GET", path, nil, http.StatusOK)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	return out, json.Unmarshal(raw, &out)
}
