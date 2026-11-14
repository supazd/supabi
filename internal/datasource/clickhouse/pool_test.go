package clickhouse

import (
	"context"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

// See .agents/design/query-ir.md §6.9. Nothing is connected to: a pool opens
// its connections when they are first asked for.
func TestPoolIsSizedByTheConfig(t *testing.T) {
	opened, err := datasource.Open(context.Background(), "clickhouse", datasource.Config{
		Settings: map[string]string{"host": "127.0.0.1"},
		MaxConns: 14,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	if got := opened.(*conn).db.Stats().MaxOpenConnections; got != 14 {
		t.Errorf("the pool opens up to %d connections, want 14", got)
	}
}
