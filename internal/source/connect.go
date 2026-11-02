// Package source opens workspace data sources for both interactive and
// background queries.
package source

import (
	"context"
	"strconv"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/secret"
	"github.com/supazd/supabi/internal/store"
)

type Connections struct {
	Pool    *pgxpool.Pool
	Secrets *secret.Box
	Conns   *datasource.Manager
}

// MaxConcurrent stays below each driver's pool so waiting is visible and
// timed.
func MaxConcurrent(d store.Datasource) int {
	if d.MaxConcurrentQueries != nil {
		return *d.MaxConcurrentQueries
	}
	return 8
}
func Version(d store.Datasource) string { return strconv.FormatInt(d.UpdatedAt.UnixNano(), 10) }

func (c Connections) Connect(ctx context.Context, s store.Scope, d store.Datasource) (datasource.Conn, error) {
	return c.Conns.Get(ctx, d.ID, Version(d), d.Type, MaxConcurrent(d), func() (datasource.Config, error) {
		cfg := datasource.Config{Settings: d.Settings, DataTimezone: d.DataTimezone}
		if len(d.Secret) > 0 {
			var err error
			cfg.Password, err = c.Secrets.Open(d.Secret)
			if err != nil {
				return cfg, err
			}
		}
		return cfg, nil
	})
}
