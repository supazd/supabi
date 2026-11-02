// Package scheduler enqueues time-triggered work, without executing it.
package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/store"
)

type Scheduler struct {
	Pool   *pgxpool.Pool
	Logger *slog.Logger
}

func (s *Scheduler) Run(ctx context.Context) error {
	s.Logger.Info("scheduler started")
	// Ticking more often than the hourly jobs keeps them prompt after a
	// restart; their deduplication keys make the extra ticks no-ops.
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		now := time.Now()
		if err := store.EnqueueExportCleanup(ctx, s.Pool, now); err != nil && ctx.Err() == nil {
			s.Logger.ErrorContext(ctx, "schedule export cleanup", "error", err)
		}
		// Expired sessions and audit events past their retention.
		if err := store.EnqueueMaintenance(ctx, s.Pool, now); err != nil && ctx.Err() == nil {
			s.Logger.ErrorContext(ctx, "schedule maintenance", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
