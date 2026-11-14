package mysql

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

// See .agents/design/query-ir.md §6.9. Nothing is connected to: a pool opens
// its connections when they are first asked for.
func TestPoolIsSizedByTheConfig(t *testing.T) {
	for _, name := range []string{"mysql", "starrocks", "doris"} {
		t.Run(name, func(t *testing.T) {
			opened, err := datasource.Open(context.Background(), name, datasource.Config{
				Settings: map[string]string{"host": "127.0.0.1", "database": "db", "user": "reader", "tls": "false"},
				MaxConns: 14,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer opened.Close()
			if got := opened.(*conn).db.Stats().MaxOpenConnections; got != 14 {
				t.Errorf("the pool opens up to %d connections, want 14", got)
			}
		})
	}
}
