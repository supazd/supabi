package clickhouse_test

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	driver "github.com/ClickHouse/clickhouse-go/v2"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/id"
)

// A query nobody waits for any more must stop in the database too, not only
// stop being waited for: this is what cancelling a run in data exploration
// relies on.
func TestCancelledQueryStopsInTheDatabase(t *testing.T) {
	raw := os.Getenv("SUPABI_TEST_CLICKHOUSE_URL")
	if raw == "" {
		t.Skip("SUPABI_TEST_CLICKHOUSE_URL is not set")
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := u.User.Password()
	admin := driver.OpenDB(&driver.Options{Addr: []string{u.Host}, Auth: driver.Auth{Username: u.User.Username(), Password: password}})
	defer admin.Close()
	conn, err := datasource.Open(context.Background(), "clickhouse", datasource.Config{
		Settings: map[string]string{"host": u.Hostname(), "port": u.Port(), "database": "default", "user": u.User.Username()},
		Password: password,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Work that would take hours, and that the server can leave between
	// blocks. sleep() would not do: it cannot be interrupted.
	mark := id.New("cancel")
	slow := "SELECT count() FROM numbers(1000000000000) WHERE sipHash64(number) = 1 /* " + mark + " */"
	running := func() int {
		t.Helper()
		var n int
		if err := admin.QueryRow("SELECT count() FROM system.processes WHERE query LIKE '%" + mark + "%' AND query NOT LIKE '%system.processes%'").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := conn.Query(ctx, slow, nil)
		done <- err
	}()
	for deadline := time.Now().Add(5 * time.Second); running() == 0; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the query never started")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a cancelled query returned a result")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled query was still waited for")
	}
	for deadline := time.Now().Add(5 * time.Second); running() > 0; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatal("the query was still running in the database 5s after it was cancelled")
		}
	}
}
