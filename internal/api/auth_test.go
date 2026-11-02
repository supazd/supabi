package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/store"
)

// Every operation must state what it requires, and the table must not name
// operations that no longer exist.
func TestEveryOperationHasARequirement(t *testing.T) {
	iface := reflect.TypeOf((*gen.StrictServerInterface)(nil)).Elem()
	defined := map[string]bool{}
	for i := range iface.NumMethod() {
		name := iface.Method(i).Name
		defined[name] = true
		if _, ok := requirements[name]; !ok {
			t.Errorf("operation %s has no entry in the requirements table", name)
		}
	}
	for name := range requirements {
		if !defined[name] {
			t.Errorf("the requirements table names %s, which is not an operation", name)
		}
	}
}

func TestSetupHappensOnceAndSignsIn(t *testing.T) {
	c := newServer(t)
	if info := c.expect("GET", "/auth/session", nil, 200, ""); info["authenticated"] != false || info["setupRequired"] != true {
		t.Fatalf("before setup: %v", info)
	}
	// Nothing works before setup except the auth endpoints.
	c.expect("GET", "/datasets", nil, 401, "unauthenticated")

	c.expect("POST", "/auth/setup", map[string]any{"email": "not-an-email", "displayName": "A", "password": adminPassword}, 400, "invalid_email")
	c.expect("POST", "/auth/setup", map[string]any{"email": adminEmail, "displayName": " ", "password": adminPassword}, 400, "name_required")
	c.expect("POST", "/auth/setup", map[string]any{"email": adminEmail, "displayName": "A", "password": "short"}, 400, "invalid_password")

	info := c.expect("POST", "/auth/setup", map[string]any{"email": " Admin@Example.com ", "displayName": "Admin", "password": adminPassword}, 200, "")
	user := info["user"].(map[string]any)
	if info["authenticated"] != true || user["email"] != adminEmail || user["isOrgAdmin"] != true || info["role"] != "admin" {
		t.Errorf("after setup: %v", info)
	}
	if info["workspace"].(map[string]any)["id"] != "ws_default" {
		t.Errorf("workspace = %v", info["workspace"])
	}
	// The same browser is now signed in.
	if again := c.expect("GET", "/auth/session", nil, 200, ""); again["authenticated"] != true || again["setupRequired"] != false {
		t.Errorf("session after setup: %v", again)
	}
	c.expect("GET", "/datasets", nil, 200, "")

	// A second setup is refused, for this browser and for a stranger.
	c.expect("POST", "/auth/setup", map[string]any{"email": "b@example.com", "displayName": "B", "password": adminPassword}, 409, "already_set_up")
	c.anonymous().expect("POST", "/auth/setup", map[string]any{"email": "b@example.com", "displayName": "B", "password": adminPassword}, 409, "already_set_up")
}

func TestSessionCookieAttributes(t *testing.T) {
	c := newServer(t)
	body := strings.NewReader(`{"email":"` + adminEmail + `","displayName":"Admin","password":"` + adminPassword + `"}`)
	req, _ := http.NewRequest("POST", c.server.URL+"/api/v1/auth/setup", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-Proto", "https")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	cookies := resp.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("got %d cookies, want 1", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != sessionCookie || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
		t.Errorf("cookie = %+v", cookie)
	}
	// What is stored is a hash of the token, not the token.
	var stored int
	if err := c.db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE token_hash = $1`, []byte(cookie.Value)).Scan(&stored); err != nil || stored != 0 {
		t.Errorf("the raw token is stored: %d, %v", stored, err)
	}
}

func TestLoginAndLogout(t *testing.T) {
	c := newClient(t)
	stranger := c.anonymous()

	// An unknown account and a wrong password are indistinguishable.
	stranger.expect("POST", "/auth/login", map[string]any{"email": "nobody@example.com", "password": adminPassword}, 401, "invalid_credentials")
	stranger.expect("POST", "/auth/login", map[string]any{"email": adminEmail, "password": "wrong-password"}, 401, "invalid_credentials")
	stranger.expect("POST", "/auth/login", map[string]any{"email": "nonsense", "password": "x"}, 401, "invalid_credentials")
	stranger.expect("GET", "/datasets", nil, 401, "unauthenticated")

	info := stranger.expect("POST", "/auth/login", map[string]any{"email": "ADMIN@example.com", "password": adminPassword}, 200, "")
	if info["authenticated"] != true {
		t.Fatalf("login: %v", info)
	}
	stranger.expect("GET", "/datasets", nil, 200, "")
	stranger.expect("POST", "/auth/logout", nil, 204, "")
	stranger.expect("GET", "/datasets", nil, 401, "unauthenticated")
	stranger.expect("POST", "/auth/logout", nil, 204, "") // signing out twice is not an error
	// The first browser's session is a different one and is unaffected.
	c.expect("GET", "/datasets", nil, 200, "")
}

func TestLoginIsThrottled(t *testing.T) {
	c := newClient(t)
	attacker := c.anonymous()
	for range 5 {
		attacker.expect("POST", "/auth/login", map[string]any{"email": adminEmail, "password": "guess-guess"}, 401, "invalid_credentials")
	}
	// Now even the right password is refused for a while…
	attacker.expect("POST", "/auth/login", map[string]any{"email": adminEmail, "password": adminPassword}, 429, "too_many_attempts")
	// …but other accounts are not affected, nor is the admin's existing session.
	attacker.expect("POST", "/auth/login", map[string]any{"email": "other@example.com", "password": "guess-guess"}, 401, "invalid_credentials")
	c.expect("GET", "/datasets", nil, 200, "")

	// Another instance on the same database counts the same failures.
	second := *c.api
	second.Logins = &store.LoginThrottle{Pool: c.db.Pool, Max: 5, Window: time.Minute}
	mux := http.NewServeMux()
	second.Register(mux)
	server := httptest.NewServer(mux)
	defer server.Close()
	elsewhere := (&client{api: &second, t: t, server: server, db: c.db, dataDir: c.dataDir}).anonymous()
	elsewhere.expect("POST", "/auth/login", map[string]any{"email": adminEmail, "password": adminPassword}, 429, "too_many_attempts")

	// Once the window has passed the right password works, and the count is forgotten.
	ctx := context.Background()
	if _, err := c.db.Pool.Exec(ctx, `UPDATE login_throttle SET window_start=window_start-interval '2 minutes'`); err != nil {
		t.Fatal(err)
	}
	elsewhere.expect("POST", "/auth/login", map[string]any{"email": adminEmail, "password": adminPassword}, 200, "")
	var left int
	if err := c.db.Pool.QueryRow(ctx, `SELECT count(*) FROM login_throttle WHERE email=$1`, adminEmail).Scan(&left); err != nil || left != 0 {
		t.Fatalf("failures kept after signing in: %d %v", left, err)
	}
	// A failure after the window starts a new one rather than adding to the old.
	if _, err := c.db.Pool.Exec(ctx, `INSERT INTO login_throttle VALUES('org_default','old@example.com',5,now()-interval '2 minutes')`); err != nil {
		t.Fatal(err)
	}
	attacker.expect("POST", "/auth/login", map[string]any{"email": "old@example.com", "password": "guess-guess"}, 401, "invalid_credentials")
	if err := c.db.Pool.QueryRow(ctx, `SELECT failures FROM login_throttle WHERE email='old@example.com'`).Scan(&left); err != nil || left != 1 {
		t.Fatalf("failures in a new window: %d %v", left, err)
	}
}

func TestCrossSiteRequestsAreRefused(t *testing.T) {
	c := newClient(t)
	send := func(method, origin string) int {
		req, _ := http.NewRequest(method, c.server.URL+"/api/v1/auth/logout", nil)
		if method == "GET" {
			req, _ = http.NewRequest(method, c.server.URL+"/api/v1/auth/session", nil)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := send("POST", "https://evil.example"); got != 403 {
		t.Errorf("POST from another site: %d, want 403", got)
	}
	if info := c.expect("GET", "/auth/session", nil, 200, ""); info["authenticated"] != true {
		t.Error("the cross-site request signed the user out")
	}
	if got := send("GET", "https://evil.example"); got != 200 {
		t.Errorf("GET from another site: %d, want 200 (reads are protected by the browser's same-origin policy)", got)
	}
	if got := send("POST", c.server.URL); got != 204 {
		t.Errorf("POST from the same origin: %d, want 204", got)
	}
}

func TestRolesDecideWhatMembersCanDo(t *testing.T) {
	admin := newClient(t)
	const password = "member-password"
	for _, role := range []string{"viewer", "developer"} {
		admin.expect("POST", "/users", map[string]any{"email": role + "@example.com", "displayName": role, "password": password}, 201, "")
		admin.expect("POST", "/members", map[string]any{"userId": userID(t, admin, role+"@example.com"), "role": role}, 201, "")
	}
	viewer := admin.signedIn("viewer@example.com", password)
	developer := admin.signedIn("developer@example.com", password)
	if info := developer.expect("GET", "/auth/session", nil, 200, ""); info["role"] != "developer" {
		t.Errorf("session of a developer = %v", info)
	}

	// Data sources, SQL and datasets: developers and up.
	failed := viewer.expect("POST", "/datasources", admin.datasourceInput("x"), 403, "forbidden")
	if failed["params"].(map[string]any)["role"] != "developer" {
		t.Errorf("params = %v", failed["params"])
	}
	viewer.expect("GET", "/datasources", nil, 403, "forbidden")
	sourceID := developer.expect("POST", "/datasources", admin.datasourceInput("db"), 201, "")["id"].(string)
	datasetInput := map[string]any{"name": "订单", "datasourceId": sourceID, "spec": admin.spec(nil)}
	viewer.expect("POST", "/datasets", datasetInput, 403, "forbidden")
	datasetID := developer.expect("POST", "/datasets", datasetInput, 201, "")["id"].(string)

	// Viewers do not query datasets: they will reach data through dashboards.
	q := `{"query":{"version":1,"dataset":"` + datasetID + `","measures":[{"field":"revenue","agg":"sum"}]}}`
	viewer.expect("POST", "/query", q, 403, "forbidden")
	viewer.expect("GET", "/datasets", nil, 403, "forbidden")
	developer.expect("POST", "/query", q, 200, "")
	viewer.expect("GET", "/charts", nil, 200, "")

	// Members and settings: admins only.
	for name, c := range map[string]*client{"viewer": viewer, "developer": developer} {
		if failed := c.expect("GET", "/members", nil, 403, "forbidden"); failed["params"].(map[string]any)["role"] != "admin" {
			t.Errorf("%s: params = %v", name, failed["params"])
		}
		c.expect("PATCH", "/members/"+userID(t, admin, "viewer@example.com"), map[string]any{"role": "admin"}, 403, "forbidden")
		c.expect("PUT", "/workspace", map[string]any{"name": "x"}, 403, "forbidden")
		c.expect("GET", "/version", nil, 200, "")
	}

	// Who did what is recorded.
	var sourceCreator, datasetCreator string
	if err := admin.db.Pool.QueryRow(context.Background(), `
		SELECT (SELECT u.email FROM datasources d JOIN users u ON u.id = d.created_by WHERE d.id = $1),
		       (SELECT u.email FROM datasets d JOIN users u ON u.id = d.created_by WHERE d.id = $2)`, sourceID, datasetID).
		Scan(&sourceCreator, &datasetCreator); err != nil || sourceCreator != "developer@example.com" || datasetCreator != "developer@example.com" {
		t.Errorf("creators = %q, %q, %v", sourceCreator, datasetCreator, err)
	}
}
