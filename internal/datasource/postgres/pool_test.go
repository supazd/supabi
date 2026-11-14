package postgres_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/datasource"
	_ "github.com/supazd/supabi/internal/datasource/postgres"
	"github.com/supazd/supabi/internal/id"
	"github.com/supazd/supabi/internal/testdb"
)

// A data source runs as many statements at once as its limit allows, and a
// connection test is still answered while they run: the pool has a connection
// for each of them and some to spare. See .agents/design/query-ir.md §6.9.
func TestPoolHoldsEveryStatementOfTheLimit(t *testing.T) {
	db := testdb.New(t)
	settings, password := db.Settings()
	manager := datasource.NewManager()
	t.Cleanup(manager.Close)
	// More than a pool sized by the driver's default would hold on most machines.
	const limit = 20
	conn, err := manager.Get(context.Background(), "src_pool", "1", "postgres", limit, func() (datasource.Config, error) {
		return datasource.Config{Settings: settings, Password: password}, nil
	})
	if err != nil {
		t.Fatal(err)
	}

	mark := id.New("pool")
	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup
	for range limit {
		wg.Go(func() { _, _ = conn.Query(ctx, "SELECT pg_sleep(60) /* "+mark+" */", nil) })
	}
	t.Cleanup(func() {
		cancel()
		wg.Wait()
	})
	running := func() int {
		t.Helper()
		var n int
		if err := db.Admin.QueryRow(context.Background(),
			`SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE '%' || $1 || '%'`, mark).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	for deadline := time.Now().Add(10 * time.Second); running() < limit; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d statements were running in the database at once", running(), limit)
		}
	}

	pingCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := conn.Ping(pingCtx); err != nil {
		t.Fatalf("a connection test while every slot was taken: %v", err)
	}
}
