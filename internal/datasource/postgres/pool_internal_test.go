package postgres

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

// See .agents/design/query-ir.md §6.9. Nothing is connected to: a pool opens
// its connections when they are first asked for.
func TestPoolIsSizedByTheConfig(t *testing.T) {
	settings := map[string]string{"host": "127.0.0.1", "database": "db", "user": "reader", "sslmode": "disable"}
	for _, c := range []struct{ maxConns, want int }{{14, 14}, {0, 1}} {
		opened, err := datasource.Open(context.Background(), "postgres", datasource.Config{Settings: settings, MaxConns: c.maxConns})
		if err != nil {
			t.Fatal(err)
		}
		cfg := opened.(*conn).pool.Config()
		opened.Close()
		if int(cfg.MaxConns) != c.want {
			t.Errorf("MaxConns %d: the pool opens up to %d connections, want %d", c.maxConns, cfg.MaxConns, c.want)
		}
		if cfg.MaxConnIdleTime != datasource.ConnMaxIdleTime {
			t.Errorf("MaxConns %d: a connection is kept %v without use, want %v", c.maxConns, cfg.MaxConnIdleTime, datasource.ConnMaxIdleTime)
		}
	}
}
