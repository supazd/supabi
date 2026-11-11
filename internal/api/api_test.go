package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/assistant"
	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/postgres"
	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
	"github.com/supazd/supabi/internal/testdb"
)

// client is one browser: it keeps its own cookies.
type client struct {
	api    *Server
	t      *testing.T
	server *httptest.Server
	db     *testdb.DB
	http   *http.Client
	// dataDir is the test's own data directory, for local export files.
	dataDir string
	// workspace is the workspace of the address the browser's page is at,
	// which its calls name; a page with none goes by the session.
	workspace string
}

// at returns another page of the same browser, the same session, at an
// address in the workspace.
func (c *client) at(workspace string) *client {
	page := *c
	page.workspace = workspace
	return &page
}

const adminEmail, adminPassword = "admin@example.com", "admin-password"

// anonymous returns another browser talking to the same server, not signed in.
func (c *client) anonymous() *client {
	jar, _ := cookiejar.New(nil)
	return &client{api: c.api, t: c.t, server: c.server, db: c.db, dataDir: c.dataDir, http: &http.Client{Jar: jar}}
}

// signedIn returns another browser signed in as the given account.
func (c *client) signedIn(email, password string) *client {
	c.t.Helper()
	other := c.anonymous()
	other.expect("POST", "/auth/login", map[string]any{"email": email, "password": password}, 200, "")
	return other
}

// newClient starts the API on a fresh metadata schema that also holds a small
// orders table to query, and returns a browser signed in as the administrator.
func newClient(t *testing.T) *client {
	t.Helper()
	c := newServer(t)
	c.expect("POST", "/auth/setup", map[string]any{"email": adminEmail, "displayName": "Admin", "password": adminPassword}, 200, "")
	return c
}

// newServer is newClient before anyone has set the installation up.
func newServer(t *testing.T) *client {
	t.Helper()
	db := testdb.New(t)
	ctx := context.Background()
	if _, err := store.Migrate(ctx, db.Pool, store.CoreMigrations()); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, db.Pool); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `
		CREATE TABLE orders (id int, order_date date, amount numeric(12,2), region text);
		INSERT INTO orders VALUES (1, '2026-01-10', 100.50, '华东'), (2, '2026-02-10', 200.00, '华东'), (3, '2026-02-20', 300.25, '华南');
	`); err != nil {
		t.Fatal(err)
	}
	secrets, err := secret.NewBox(secret.GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	conns := datasource.NewManager()
	dataDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := &Server{
		Pool: db.Pool, Secrets: secrets, Conns: conns, Logins: &store.LoginThrottle{Pool: db.Pool, Max: 5, Window: time.Minute},
		Logger: logger,
		Now:    func() time.Time { return time.Date(2026, 3, 10, 9, 0, 0, 0, time.UTC) },
		// Nothing is kept unless a test's data source asks for it, so tests
		// that change data see the change.
		Cache:    qcache.New(qcache.NewMemory(64<<20), logger),
		CacheTTL: func(context.Context) (time.Duration, error) { return 0, nil },
		Audit:    store.AuditEvents{Pool: db.Pool},
	}
	api.Assistant = &assistant.Service{Pool: db.Pool, Secrets: secrets, LLM: &llm.Client{Idle: 10 * time.Second}, Logger: logger, Now: api.Now}
	mux := http.NewServeMux()
	api.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		server.Close()
		conns.Close()
	})
	return (&client{api: api, t: t, server: server, db: db, dataDir: dataDir}).anonymous()
}

// do sends a request and decodes the JSON response into a generic value.
func (c *client) do(method, path string, body any) (int, any) {
	c.t.Helper()
	var reader io.Reader
	if raw, ok := body.(string); ok {
		reader = strings.NewReader(raw)
	} else if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			c.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, c.server.URL+"/api/v1"+path, reader)
	if err != nil {
		c.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.workspace != "" {
		req.Header.Set(workspaceHeader, c.workspace)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if len(raw) == 0 {
		return resp.StatusCode, nil
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		c.t.Fatalf("%s %s: content type %q, body %s", method, path, ct, raw)
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		c.t.Fatalf("%s %s: invalid JSON %s", method, path, raw)
	}
	return resp.StatusCode, decoded
}

// expect checks the status and, for errors, the error code.
func (c *client) expect(method, path string, body any, status int, code string) map[string]any {
	c.t.Helper()
	got, decoded := c.do(method, path, body)
	object, _ := decoded.(map[string]any)
	if got != status || (code != "" && object["code"] != code) {
		c.t.Fatalf("%s %s: got %d %v, want %d %s", method, path, got, decoded, status, code)
	}
	return object
}

// editing supplies the current revision for tests of other editor behavior.
// Explicit revisions are never replaced. Protocol and concurrency tests use
// expect/do directly, including requests missing the required revision.
func (c *client) editing(method, path string, body any, status int, code string) map[string]any {
	c.t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		c.t.Fatal(err)
	}
	var input map[string]any
	if err := json.Unmarshal(raw, &input); err != nil {
		c.t.Fatal(err)
	}
	if _, exists := input["expectedRevision"]; !exists {
		input["expectedRevision"] = 1
		if got, value := c.do("GET", strings.TrimSuffix(path, "/impact"), nil); got == 200 {
			input["expectedRevision"] = value.(map[string]any)["revision"]
		}
	}
	return c.expect(method, path, input, status, code)
}

func (c *client) datasourceInput(name string) map[string]any {
	settings, password := c.db.Settings()
	return map[string]any{"name": name, "type": "postgres", "settings": settings, "password": password, "dataTimezone": "Asia/Shanghai"}
}

func (c *client) spec(mutate func(spec map[string]any)) map[string]any {
	spec := map[string]any{
		"specVersion": 1,
		"source":      map[string]any{"type": "sql", "sql": fmt.Sprintf("SELECT * FROM %s.orders WHERE order_date >= {{since}}", c.db.Schema)},
		"params":      []any{map[string]any{"name": "since", "type": "date", "required": true, "default": "2026-01-01"}},
		"fields": []any{
			map[string]any{"key": "order_date", "label": "下单日期", "column": "order_date", "type": "date", "role": "dimension"},
			map[string]any{"key": "amount", "label": "金额", "column": "amount", "type": "decimal", "role": "dimension"},
			map[string]any{"key": "region", "label": "地区", "column": "region", "type": "string", "role": "dimension"},
			map[string]any{"key": "revenue", "label": "销售额", "column": "amount", "type": "decimal", "role": "measure"},
		},
	}
	if mutate != nil {
		mutate(spec)
	}
	return spec
}

func TestVersionAndTypes(t *testing.T) {
	c := newClient(t)
	if v := c.expect("GET", "/version", nil, 200, ""); v["version"] == nil || v["features"] == nil {
		t.Errorf("version = %v", v)
	}
	_, types := c.do("GET", "/datasource-types", nil)
	encoded, _ := json.Marshal(types)
	if !strings.Contains(string(encoded), `{"name":"host","required":true}`) || !strings.Contains(string(encoded), `"category":"oltp","name":"postgres"`) {
		t.Errorf("datasource types = %s", encoded)
	}
}

func TestResolveTimeRange(t *testing.T) {
	c := newClient(t)
	// The server's clock says 2026-03-10.
	got := c.expect("POST", "/time-ranges/resolve", map[string]any{"range": map[string]any{"last": map[string]any{"n": 1, "unit": "month"}}}, 200, "")
	if got["start"] != "2026-02-01T00:00:00" || got["end"] != "2026-03-01T00:00:00" {
		t.Fatalf("last month: %v", got)
	}
	open := c.expect("POST", "/time-ranges/resolve", map[string]any{"range": map[string]any{"bounds": map[string]any{"start": map[string]any{"fixed": "2026-01-04"}}}}, 200, "")
	if open["start"] != "2026-01-04T00:00:00" || open["end"] != nil {
		t.Fatalf("an open end: %v", open)
	}
	c.expect("POST", "/time-ranges/resolve", map[string]any{"range": map[string]any{"start": "2026-03-02", "end": "2026-03-01"}}, 400, "invalid_time_range")
	c.expect("POST", "/time-ranges/resolve", map[string]any{"range": map[string]any{"lately": true}}, 400, "invalid_time_range")
	// A Tuesday: weeks from Wednesday began six days ago.
	week := c.expect("POST", "/time-ranges/resolve", map[string]any{"range": map[string]any{"current": "week", "grain": "week", "weekStart": 3, "includeNull": true}}, 200, "")
	if week["start"] != "2026-03-04T00:00:00" || week["end"] != "2026-03-11T00:00:00" {
		t.Fatalf("this week from Wednesday: %v", week)
	}
	session := c.expect("GET", "/auth/session", nil, 200, "")
	if workspace, _ := session["workspace"].(map[string]any); workspace["weekStart"] != float64(1) {
		t.Fatalf("the session says which day weeks start on: %v", session["workspace"])
	}
}

func TestDatasources(t *testing.T) {
	c := newClient(t)

	// Testing a connection reports failure as data, with the database's reason.
	wrong := c.datasourceInput("x")
	wrong["password"] = "not-the-password"
	if r := c.expect("POST", "/datasources/test", wrong, 200, ""); r["ok"] != false || r["message"] == "" {
		t.Errorf("test with a wrong password = %v", r)
	}
	if r := c.expect("POST", "/datasources/test", c.datasourceInput("x"), 200, ""); r["ok"] != true {
		t.Errorf("test with the right password = %v", r)
	}

	bad := func(mutate func(in map[string]any), code string) {
		t.Helper()
		in := c.datasourceInput("bad")
		mutate(in)
		c.expect("POST", "/datasources", in, 400, code)
		c.expect("POST", "/datasources/test", in, 400, code)
	}
	bad(func(in map[string]any) { in["name"] = "  " }, "name_required")
	bad(func(in map[string]any) { in["type"] = "oracle" }, "unknown_datasource_type")
	bad(func(in map[string]any) { delete(in["settings"].(map[string]string), "host") }, "invalid_settings")
	bad(func(in map[string]any) { in["settings"].(map[string]string)["sslmode"] = "maybe" }, "invalid_settings")
	bad(func(in map[string]any) { in["settings"].(map[string]string)["options"] = "-c x=y" }, "invalid_settings")
	bad(func(in map[string]any) { in["dataTimezone"] = "Mars/Olympus" }, "invalid_timezone")
	c.expect("POST", "/datasources", `{"name": `, 400, "invalid_request")

	created := c.expect("POST", "/datasources", c.datasourceInput("生产库"), 201, "")
	id := created["id"].(string)
	if created["hasPassword"] != true || created["dataTimezone"] != "Asia/Shanghai" || !strings.HasPrefix(id, "src_") {
		t.Errorf("created = %v", created)
	}
	// The password never comes back, and is not stored in the clear. (The
	// test database's password equals its user name, so the response cannot
	// simply be searched for it.)
	_, password := c.db.Settings()
	for key := range created {
		if strings.Contains(strings.ToLower(key), "password") && key != "hasPassword" {
			t.Errorf("the response has a %q property", key)
		}
	}
	var stored []byte
	if err := c.db.Pool.QueryRow(context.Background(), `SELECT secret FROM datasources WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) == 0 || bytes.Contains(stored, []byte(password)) {
		t.Errorf("stored secret is missing or contains the plaintext password")
	}

	c.expect("POST", "/datasources", c.datasourceInput("生产库"), 409, "name_taken")
	c.expect("GET", "/datasources/"+id, nil, 200, "")

	// A change keeps the password that is not sent again, and the type.
	change := c.datasourceInput("生产库（只读）")
	delete(change, "password")
	change["dataTimezone"] = "UTC"
	if r := c.expect("POST", "/datasources/"+id+"/test", change, 200, ""); r["ok"] != true {
		t.Errorf("test of a change with the saved password = %v", r)
	}
	if updated := c.expect("PUT", "/datasources/"+id, change, 200, ""); updated["name"] != "生产库（只读）" || updated["dataTimezone"] != "UTC" || updated["hasPassword"] != true {
		t.Errorf("updated = %v", updated)
	}
	if r := c.expect("POST", "/datasources/"+id+"/test", nil, 200, ""); r["ok"] != true {
		t.Errorf("test as saved = %v", r)
	}
	// The saved password goes only where it was saved for: sent to another
	// server, as another user or with other protection, it has to be typed
	// again. It could otherwise be had by pointing the data source at a
	// server of one's own.
	for setting, value := range map[string]string{"host": "198.51.100.7", "port": "6543", "user": "someone_else", "sslmode": "verify-full"} {
		moved := c.datasourceInput("生产库（只读）")
		delete(moved, "password")
		settings := map[string]any{}
		raw, _ := json.Marshal(moved["settings"])
		_ = json.Unmarshal(raw, &settings)
		settings[setting] = value
		moved["settings"] = settings
		c.expect("POST", "/datasources/"+id+"/test", moved, 400, "datasource_password_required")
		c.expect("PUT", "/datasources/"+id, moved, 400, "datasource_password_required")
	}
	change["password"] = "not-the-password"
	if r := c.expect("POST", "/datasources/"+id+"/test", change, 200, ""); r["ok"] != false || r["message"] == "" {
		t.Errorf("test of a change to a wrong password = %v", r)
	}
	change["type"] = "mysql"
	c.expect("PUT", "/datasources/"+id, change, 400, "")
	c.expect("PUT", "/datasources/src_nope", c.datasourceInput("x"), 404, "not_found")
	c.expect("PUT", "/datasources/"+id, c.datasourceInput("生产库"), 200, "")
	c.expect("GET", "/datasources/src_nope", nil, 404, "not_found")
	if _, list := c.do("GET", "/datasources", nil); len(list.([]any)) != 1 {
		t.Errorf("list = %v", list)
	}

	// Describe uses a sample value for the parameter that has no default.
	source := map[string]any{"type": "sql", "sql": fmt.Sprintf("SELECT id, amount, order_date FROM %s.orders WHERE order_date >= {{since}}", c.db.Schema)}
	params := []any{map[string]any{"name": "since", "type": "date", "required": true}}
	_, columns := c.do("POST", "/datasources/"+id+"/describe", map[string]any{"source": source, "params": params})
	encoded, _ := json.Marshal(columns)
	if want := `[{"dbType":"int4","name":"id","type":"integer"},{"dbType":"numeric","name":"amount","type":"decimal"},{"dbType":"date","name":"order_date","type":"date"}]`; string(encoded) != want {
		t.Errorf("describe:\n got %s\nwant %s", encoded, want)
	}
	c.expect("POST", "/datasources/"+id+"/describe", map[string]any{"source": map[string]any{"type": "sql", "sql": "SELECT nope FROM " + c.db.Schema + ".orders"}}, 422, "database_error")
	// A mistake the database can place comes back with where it is in the
	// SQL as written: in characters, counting what surrounds the statement.
	misspelt := "\n SELECT '华东' AS area, amount FROM " + c.db.Schema + ".orders WHERE order_date >= {{since}} AND amuont > 0"
	failed := c.expect("POST", "/datasources/"+id+"/describe", map[string]any{"source": map[string]any{"type": "sql", "sql": misspelt}, "params": params}, 422, "database_error")
	if want := float64(len([]rune(misspelt[:strings.Index(misspelt, "amuont")]))); failed["position"] != want {
		t.Errorf("position = %v, want %v: %v", failed["position"], want, failed["message"])
	}
	c.expect("POST", "/datasources/"+id+"/describe", map[string]any{"source": map[string]any{"type": "sql", "sql": "DROP TABLE orders"}}, 400, "source_not_select")

	// How the database would run it, in the database's own words; the same rules hold.
	plan := c.expect("POST", "/datasources/"+id+"/explain", map[string]any{"source": source, "params": params}, 200, "")
	if len(plan["columns"].([]any)) == 0 || len(plan["rows"].([]any)) == 0 {
		t.Errorf("plan = %v", plan)
	}
	failed = c.expect("POST", "/datasources/"+id+"/explain", map[string]any{"source": map[string]any{"type": "sql", "sql": misspelt}, "params": params}, 422, "database_error")
	if want := float64(len([]rune(misspelt[:strings.Index(misspelt, "amuont")]))); failed["position"] != want {
		t.Errorf("explain position = %v, want %v: %v", failed["position"], want, failed["message"])
	}
	c.expect("POST", "/datasources/"+id+"/explain", map[string]any{"source": map[string]any{"type": "sql", "sql": "DROP TABLE orders"}}, 400, "source_not_select")

	// The tables an author can write SQL against.
	catalog := c.expect("GET", "/datasources/"+id+"/tables", nil, 200, "")
	var orders map[string]any
	for _, table := range catalog["tables"].([]any) {
		if table := table.(map[string]any); table["name"] == "orders" && table["schema"] == c.db.Schema {
			orders = table
		}
	}
	if orders == nil {
		t.Fatalf("orders is not among the %d tables", len(catalog["tables"].([]any)))
	}
	if columns, _ := json.Marshal(orders["columns"].([]any)[:2]); string(columns) != `[{"dbType":"integer","name":"id"},{"dbType":"date","name":"order_date"}]` {
		t.Errorf("columns = %s", columns)
	}
	c.expect("GET", "/datasources/src_nope/tables", nil, 404, "not_found")
	c.expect("POST", "/datasources/"+id+"/describe", map[string]any{"source": source}, 400, "undeclared_param")
	c.expect("POST", "/datasources/src_nope/describe", map[string]any{"source": source, "params": params}, 404, "not_found")

	c.expect("DELETE", "/datasources/"+id, nil, 204, "")
	c.expect("DELETE", "/datasources/"+id, nil, 404, "not_found")
}

func TestDatasetsAndQueries(t *testing.T) {
	c := newClient(t)
	sourceID := c.expect("POST", "/datasources", c.datasourceInput("db"), 201, "")["id"].(string)
	input := func(name string, mutate func(map[string]any)) map[string]any {
		return map[string]any{"name": name, "datasourceId": sourceID, "spec": c.spec(mutate), "description": "订单"}
	}

	// What can be checked from the definition alone is a 400…
	c.expect("POST", "/datasets", input("d", func(s map[string]any) { s["feilds"] = []any{} }), 400, "invalid_spec")
	addField := func(field map[string]any) func(map[string]any) {
		return func(s map[string]any) { s["fields"] = append(s["fields"].([]any), field) }
	}
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "x", "label": "x", "expr": "${nope} + 1", "type": "decimal", "role": "dimension"})), 400, "unknown_reference")
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "x", "label": "销售额", "column": "amount", "type": "decimal", "role": "dimension"})), 400, "duplicate_label")
	// The earlier format, with measures in a list of their own, is not accepted.
	c.expect("POST", "/datasets", input("d", func(s map[string]any) { s["measures"] = []any{} }), 400, "invalid_spec")
	c.expect("POST", "/datasets", input(" ", nil), 400, "name_required")
	c.expect("POST", "/datasets", map[string]any{"name": "d", "datasourceId": "src_nope", "spec": c.spec(nil)}, 400, "unknown_datasource")
	// …and what only the database can tell is a 422.
	c.expect("POST", "/datasets", input("d", func(s map[string]any) { s["fields"].([]any)[1].(map[string]any)["column"] = "amuont" }), 422, "dataset_sql_error")
	c.expect("POST", "/datasets", input("d", func(s map[string]any) {
		s["fields"].([]any)[1].(map[string]any)["type"] = "string"
	}), 422, "field_type_mismatch")
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "broken", "label": "b", "expr": "SUM(${amount}", "type": "decimal", "role": "metric"})), 422, "dataset_sql_error")
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "label", "label": "l", "expr": "MAX(${region})", "type": "decimal", "role": "metric"})), 422, "field_type_mismatch")
	// A time is checked as the database gives it: written in the query zone, a date would be one too.
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "at", "label": "a", "column": "order_date", "type": "timestamp", "role": "dimension"})), 422, "field_type_mismatch")
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "last", "label": "l", "expr": "MAX(${order_date})", "type": "timestamp", "role": "metric"})), 422, "field_type_mismatch")
	times := c.expect("POST", "/datasets", input("时间", func(s map[string]any) {
		addField(map[string]any{"key": "at", "label": "a", "expr": "CAST(${order_date} AS timestamp)", "type": "timestamp", "role": "dimension"})(s)
		addField(map[string]any{"key": "last", "label": "l", "expr": "MAX(CAST(${order_date} AS timestamp))", "type": "timestamp", "role": "metric"})(s)
	}), 201, "")
	if times["validationStatus"] != "valid" {
		t.Errorf("a dataset of times = %v, want valid", times)
	}
	c.expect("DELETE", "/datasets/"+times["id"].(string), nil, 204, "")
	// Whether an expression aggregates is declared, not parsed; the database catches a wrong declaration either way.
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "half", "label": "h", "expr": "SUM(${amount}) / 2", "type": "decimal", "role": "measure"})), 422, "dataset_sql_error")
	c.expect("POST", "/datasets", input("d", addField(map[string]any{"key": "double", "label": "d", "expr": "${amount} * 2", "type": "decimal", "role": "metric"})), 422, "dataset_sql_error")

	// A preview runs a definition that is not saved: row-level fields only, by name of their key.
	preview := c.expect("POST", "/datasets/preview", map[string]any{"datasourceId": sourceID, "spec": c.spec(
		addField(map[string]any{"key": "avg_order", "label": "单均", "expr": "SUM(${amount}) / NULLIF(COUNT(${amount}), 0)", "type": "decimal", "role": "metric"}))}, 200, "")
	previewColumns, _ := json.Marshal(preview["columns"])
	if want := `[{"label":"下单日期","name":"order_date","role":"dimension","type":"date"},{"label":"金额","name":"amount","role":"dimension","type":"decimal"},{"label":"地区","name":"region","role":"dimension","type":"string"},{"label":"销售额","name":"revenue","role":"dimension","type":"decimal"}]`; string(previewColumns) != want {
		t.Errorf("preview columns = %s\n             want %s", previewColumns, want)
	}
	if rows := preview["rows"].([]any); len(rows) != 3 {
		t.Errorf("preview has %d rows, want the 3 since the default date", len(rows))
	}
	c.expect("POST", "/datasets/preview", map[string]any{"datasourceId": "src_nope", "spec": c.spec(nil)}, 400, "unknown_datasource")
	c.expect("POST", "/datasets/preview", map[string]any{"datasourceId": sourceID, "spec": c.spec(func(s map[string]any) {
		s["fields"].([]any)[1].(map[string]any)["column"] = "amuont"
	})}, 422, "database_error")

	created := c.expect("POST", "/datasets", input("订单分析", nil), 201, "")
	id := created["id"].(string)
	if created["validationStatus"] != "valid" || created["revision"] != float64(1) || !strings.HasPrefix(id, "ds_") {
		t.Errorf("created = %v", created)
	}
	c.expect("POST", "/datasets", input("订单分析", nil), 409, "name_taken")

	updated := c.editing("PUT", "/datasets/"+id, input("订单分析", func(s map[string]any) {
		addField(map[string]any{"key": "orders", "label": "订单数", "column": "amount", "type": "decimal", "role": "measure"})(s)
		addField(map[string]any{"key": "avg_order", "label": "单均", "expr": "SUM(${amount}) / NULLIF(COUNT(${amount}), 0)", "type": "decimal", "role": "metric"})(s)
	}), 200, "")
	if updated["revision"] != float64(2) {
		t.Errorf("updated revision = %v", updated["revision"])
	}
	var revisions int
	if err := c.db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM dataset_revisions WHERE dataset_id = $1`, id).Scan(&revisions); err != nil || revisions != 2 {
		t.Errorf("stored revisions = %d, %v; want 2", revisions, err)
	}
	c.editing("PUT", "/datasets/ds_nope", input("x", nil), 404, "not_found")
	fetched := c.expect("GET", "/datasets/"+id, nil, 200, "")
	if fields := fetched["spec"].(map[string]any)["fields"].([]any); len(fields) != 6 {
		t.Errorf("fetched spec has %d fields, want 6", len(fields))
	}

	run := func(q string, status int, code string) map[string]any {
		t.Helper()
		return c.expect("POST", "/query", `{"query":`+strings.ReplaceAll(q, "$ID", id)+`}`, status, code)
	}
	result := run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"order_date","grain":"month","alias":"month"}],"measures":[{"field":"revenue","agg":"sum"},{"field":"orders","agg":"count"}]}`, 200, "")
	rows, _ := json.Marshal(result["rows"])
	if want := `[["2026-01-01","100.50",1],["2026-02-01","500.25",2]]`; string(rows) != want {
		t.Errorf("rows = %s, want %s", rows, want)
	}
	columns, _ := json.Marshal(result["columns"])
	if want := `[{"grain":"month","label":"下单日期","name":"month","role":"dimension","type":"date"},{"agg":"sum","label":"销售额","name":"revenue","role":"measure","type":"decimal"},{"agg":"count","label":"订单数","name":"orders","role":"measure","type":"integer"}]`; string(columns) != want {
		t.Errorf("columns = %s\n     want %s", columns, want)
	}
	// "Last month" is February, because the server's clock is pinned to 10 March.
	result = run(`{"version":1,"dataset":"$ID","measures":[{"field":"orders","agg":"count"}],"filter":{"field":"order_date","op":"time","value":{"last":{"n":1,"unit":"month"}}},"params":{"since":"2025-01-01"}}`, 200, "")
	if rows, _ := json.Marshal(result["rows"]); string(rows) != `[[2]]` {
		t.Errorf("last month = %s, want [[2]]", rows)
	}

	result = run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"region"}],"measures":[{"field":"region","agg":"count_distinct","alias":"share","compute":{"type":"percent_of_total"}}],"limit":1,"totals":[[]]}`, 200, "")
	if rows, _ := json.Marshal(result["rows"]); !strings.Contains(string(rows), `,0.5]`) {
		t.Errorf("percentage rows: %s", rows)
	}
	if columns, _ := json.Marshal(result["columns"]); !strings.Contains(string(columns), `"compute":"percent_of_total"`) || !strings.Contains(string(columns), `"format":{"style":"percent"}`) {
		t.Errorf("percentage metadata: %s", columns)
	}
	if totals, _ := json.Marshal(result["totals"]); !strings.Contains(string(totals), `"rows":[[1]]`) {
		t.Errorf("percentage totals: %s", totals)
	}

	// Totals are asked of the database: two regions in all, though the months have one and two.
	result = run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"order_date","grain":"month","alias":"month"},{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"},{"field":"region","agg":"count_distinct","alias":"regions"}],"limit":1,"totals":[["month"],[]]}`, 200, "")
	if totals, _ := json.Marshal(result["totals"]); !strings.Contains(string(totals), `"by":["month"]`) || !strings.Contains(string(totals), `"rows":[["2026-01-01","100.50",1],["2026-02-01","500.25",2]]`) || !strings.Contains(string(totals), `"by":[],"columns":[{"agg":"sum","label":"销售额","name":"revenue","role":"measure","type":"decimal"}`) || !strings.Contains(string(totals), `"rows":[["600.75",2]]`) {
		t.Errorf("totals = %s", totals)
	}
	// A condition on aggregated results would mean something else over coarser groups.
	result = run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}],"having":{"field":"revenue","op":"gt","value":0},"totals":[[]]}`, 200, "")
	if result["totals"] != nil || result["meta"].(map[string]any)["totalsOmitted"] != true {
		t.Errorf("totals with a having = %v, %v", result["totals"], result["meta"])
	}
	run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"}],"totals":[["region"]]}`, 400, "invalid_totals")
	run(`{"version":1,"dataset":"$ID","mode":"detail","columns":["region"],"totals":[[]]}`, 400, "invalid_totals")

	failed := run(`{"version":1,"dataset":"$ID","dimensions":[{"field":"nope"}]}`, 400, "unknown_field")
	if failed["params"].(map[string]any)["key"] != "nope" {
		t.Errorf("error params = %v", failed["params"])
	}
	run(`{"version":1,"dataset":"$ID","dimension":[{"field":"region"}]}`, 400, "invalid_query")
	run(`{"version":1,"dataset":"ds_nope","measures":[{"field":"revenue","agg":"sum"}]}`, 404, "dataset_not_found")
	// A measure says its aggregation; the form that did not is turned away by name, and so is a misspelt key.
	run(`{"version":1,"dataset":"$ID","measures":[{"field":"revenue"}]}`, 400, "agg_required")
	run(`{"version":1,"dataset":"$ID","measures":[{"alias":"n","adhoc":{"agg":"count","field":"revenue"}}]}`, 400, "invalid_measure")
	run(`{"version":1,"dataset":"$ID","measures":[{"field":"revenue","aggregate":"sum"}]}`, 400, "invalid_query")
	c.expect("POST", "/query", `{}`, 400, "invalid_query")

	// A data source cannot be removed while a dataset depends on it.
	c.expect("DELETE", "/datasources/"+sourceID, nil, 409, "in_use")
	c.expect("DELETE", "/datasets/"+id, nil, 204, "")
	c.expect("DELETE", "/datasets/"+id, nil, 404, "not_found")
	c.expect("DELETE", "/datasources/"+sourceID, nil, 204, "")
}

func TestUnreachableDatasource(t *testing.T) {
	c := newClient(t)
	in := c.datasourceInput("offline")
	in["settings"].(map[string]string)["port"] = "1" // nothing listens here
	sourceID := c.expect("POST", "/datasources", in, 201, "")["id"].(string)

	// An outage must not stop an analyst from saving; the dataset is marked instead.
	spec := c.spec(nil)
	created := c.expect("POST", "/datasets", map[string]any{"name": "d", "datasourceId": sourceID, "spec": spec}, 201, "")
	if created["validationStatus"] != "unvalidated" {
		t.Errorf("validationStatus = %v, want unvalidated", created["validationStatus"])
	}
	failed := c.expect("POST", "/query", `{"query":{"version":1,"dataset":"`+created["id"].(string)+`","measures":[{"field":"revenue","agg":"sum"}]}}`, 502, "datasource_unreachable")
	if message := failed["message"].(string); strings.Contains(message, "127.0.0.1") || strings.Contains(message, "dial") {
		t.Errorf("the error leaks connection details: %s", message)
	}
}
