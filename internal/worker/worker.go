// Package worker executes durable jobs; the scheduler only enqueues them.
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/exports"
	"github.com/supazd/supabi/internal/store"
)

type Worker struct {
	Pool        *pgxpool.Pool
	Exports     *exports.Service
	Logger      *slog.Logger
	Concurrency int
	// Audit records what became of exports.
	Audit audit.Recorder
}

func (w *Worker) Run(ctx context.Context) error {
	w.Logger.Info("worker started")
	var group sync.WaitGroup
	for range max(w.Concurrency, 1) {
		group.Go(func() { w.loop(ctx) })
	}
	group.Wait()
	return nil
}

func (w *Worker) loop(ctx context.Context) {
	for ctx.Err() == nil {
		j, err := store.ClaimJob(ctx, w.Pool)
		if err == nil {
			w.Process(ctx, j)
			continue
		}
		if !errors.Is(err, store.ErrNotFound) && ctx.Err() == nil {
			w.Logger.ErrorContext(ctx, "claim background job", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// Process owns the lease while a handler runs. Shutdown leaves the job for
// recovery; losing a lease stops the query and fences all publication.
func (w *Worker) Process(parent context.Context, j store.Job) {
	// The attempt keeps to the settings as they were when it began. Without
	// them it is left for recovery, like one cut short by a shutdown.
	settings, err := store.SystemSettingsInForce(parent, w.Pool, j.OrgID)
	if err != nil {
		if parent.Err() == nil {
			w.Logger.ErrorContext(parent, "read the system settings for a background job", "job", j.ID, "error", err)
		}
		return
	}
	ctx, cancel := context.WithTimeout(parent, settings.ExportTimeout)
	defer cancel()
	var progress atomic.Int64
	stopped := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		keepLease(ctx, stopped, cancel, heartbeatEvery, store.JobLease, func() (bool, error) {
			// A hung renewal must not outlive the lease it is renewing.
			beatCtx, beatCancel := context.WithTimeout(ctx, heartbeatEvery)
			defer beatCancel()
			live, err := store.HeartbeatJob(beatCtx, w.Pool, j, progress.Load())
			if err != nil && ctx.Err() == nil {
				w.Logger.WarnContext(ctx, "renew background job lease", "job", j.ID, "error", err)
			}
			return live, err
		})
	}()
	file, err := w.run(ctx, j, settings, &progress)
	close(stopped)
	<-done
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer finishCancel()
	if parent.Err() != nil {
		w.discard(finishCtx, j, file.Key)
		return
	}
	status, finishErr := store.FinishJob(finishCtx, w.Pool, j, file, exports.FailureCode(err))
	if finishErr != nil {
		w.Logger.ErrorContext(finishCtx, "finish background job", "job", j.ID, "error", finishErr)
		// An ambiguous commit may have published the file. Keep it until the
		// orphan sweep can consult the database; a lost lease is unambiguous.
		if errors.Is(finishErr, store.ErrNotFound) {
			w.discard(finishCtx, j, file.Key)
		}
		return
	}
	if status != "succeeded" {
		w.discard(finishCtx, j, file.Key)
	}
	if err != nil && j.Kind != "export" {
		// Housekeeping has no owner to show a code to; the error is for operators.
		w.Logger.ErrorContext(finishCtx, "background job failed", "job", j.ID, "kind", j.Kind, "error", err)
	}
	w.Logger.InfoContext(finishCtx, "background job finished", "job", j.ID, "kind", j.Kind, "status", status, "code", exports.FailureCode(err), "rows", file.Rows, "bytes", file.Bytes)
	if j.Kind == "export" && status != "cancelled" {
		w.recordFinish(finishCtx, j, status, exports.FailureCode(err))
	}
}

// discard removes a file that was not published. One that cannot be
// removed now is an orphan for the next cleanup to sweep.
func (w *Worker) discard(ctx context.Context, j store.Job, key string) {
	if err := w.Exports.Remove(ctx, key); err != nil {
		w.Logger.WarnContext(ctx, "remove unpublished export file", "job", j.ID, "error", err)
	}
}

// run executes a job by its kind, and returns the file an export wrote.
func (w *Worker) run(ctx context.Context, j store.Job, settings store.SystemSettings, progress *atomic.Int64) (store.ExportFile, error) {
	if j.Kind == "maintenance" {
		return store.ExportFile{}, w.maintain(ctx, j.OrgID, settings)
	}
	return w.Exports.Execute(ctx, j, settings, progress)
}

// maintain removes what has outlived its use in an org: sessions that have
// ended, audit events and records of calls to models older than the audit
// retention unless it is zero, stale counts of failed sign-ins, expired
// conditions of share links, old maintenance jobs, and workspaces deleted
// long enough ago.
func (w *Worker) maintain(ctx context.Context, orgID string, settings store.SystemSettings) error {
	sessions, err := store.DeleteExpiredSessions(ctx, w.Pool, orgID)
	if err != nil {
		return err
	}
	var events, calls int64
	if settings.AuditRetention > 0 {
		cutoff := time.Now().Add(-settings.AuditRetention)
		if events, err = store.PruneAuditEvents(ctx, w.Pool, orgID, cutoff); err != nil {
			return err
		}
		if calls, err = store.PruneAIUsage(ctx, w.Pool, orgID, cutoff); err != nil {
			return err
		}
	}
	if err := store.PruneLoginThrottle(ctx, w.Pool, orgID); err != nil {
		return err
	}
	views, err := store.PruneDashboardViews(ctx, w.Pool, orgID)
	if err != nil {
		return err
	}
	if err := store.PruneMaintenanceJobs(ctx, w.Pool, orgID); err != nil {
		return err
	}
	purged, err := w.purgeWorkspaces(ctx, orgID, settings.WorkspaceRetention)
	w.Logger.InfoContext(ctx, "maintenance done", "org", orgID, "expiredSessions", sessions, "auditEvents", events, "aiUsage", calls, "expiredDashboardViews", views, "purgedWorkspaces", purged)
	return err
}

// purgeWorkspaces purges the workspaces deleted retention ago. One that fails
// is left for the next maintenance, without holding up the rest.
func (w *Worker) purgeWorkspaces(ctx context.Context, orgID string, retention time.Duration) (int, error) {
	expired, err := store.ExpiredWorkspaces(ctx, w.Pool, orgID, retention)
	if err != nil {
		return 0, err
	}
	var errs []error
	purged := 0
	for _, workspaceID := range expired {
		removed, err := store.PurgeWorkspace(ctx, w.Pool, orgID, workspaceID, retention, func(ctx context.Context) error {
			return w.Exports.RemoveWorkspace(ctx, orgID, workspaceID)
		})
		switch {
		case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrWorkspaceNotDeleted):
			continue // purged or restored since it was listed
		case err != nil:
			errs = append(errs, fmt.Errorf("purge workspace %s: %w", workspaceID, err))
			continue
		}
		// Exports opened these connections, through the manager the API shares.
		for _, id := range removed.Datasources {
			w.Exports.Sources.Conns.Evict(id)
		}
		purged++
		w.recordPurge(ctx, orgID, workspaceID, removed.Name)
	}
	return purged, errors.Join(errs...)
}

// recordPurge records a purge that nobody asked for at the time: the
// deletion, long before, was its actor's event.
func (w *Worker) recordPurge(ctx context.Context, orgID, workspaceID, name string) {
	if w.Audit == nil {
		return
	}
	event := audit.Event{OrgID: orgID, WorkspaceID: workspaceID, At: time.Now(), Action: "workspace.purge", Outcome: audit.Success,
		Object: audit.Object{Type: "workspace", ID: workspaceID, Name: name}}
	if err := w.Audit.Record(ctx, event); err != nil {
		w.Logger.ErrorContext(ctx, "audit event not recorded", append(audit.Attrs(event), "error", err)...)
	}
}

// recordFinish records that an export succeeded or failed, as its owner's
// event. A cancellation was recorded when its owner asked for it.
func (w *Worker) recordFinish(ctx context.Context, j store.Job, status, code string) {
	if w.Audit == nil {
		return
	}
	e, email, err := store.FinishedExport(ctx, w.Pool, j)
	if err != nil {
		w.Logger.ErrorContext(ctx, "audit export finish", "job", j.ID, "error", err)
		return
	}
	event := audit.Event{OrgID: e.OrgID, WorkspaceID: e.WorkspaceID, At: time.Now(), ActorID: e.UserID, ActorEmail: email,
		Action: "export.finish", Outcome: audit.Success, Object: audit.Object{Type: "export", ID: e.ID, Name: e.Name},
		Detail: map[string]any{"status": status, "format": e.Format, "source": e.Source, "rows": e.Rows, "bytes": e.SizeBytes}}
	if status != "succeeded" {
		event.Outcome, event.Detail["error"] = audit.Failure, code
	}
	if err := w.Audit.Record(ctx, event); err != nil {
		w.Logger.ErrorContext(ctx, "audit event not recorded", append(audit.Attrs(event), "error", err)...)
	}
}

const heartbeatEvery = 2 * time.Second

// keepLease renews the lease every interval until stopped. A refused renewal
// (lost lease or cancellation) stops the job at once; a failed one is retried
// while the last renewal still holds, since publication is fenced by the lease
// anyway and one database blip must not throw away a long export.
func keepLease(ctx context.Context, stopped <-chan struct{}, cancel func(), every, lease time.Duration, beat func() (bool, error)) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	renewed := time.Now()
	for {
		select {
		case <-stopped:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			live, err := beat()
			switch {
			case err == nil && !live:
				cancel()
				return
			case err == nil:
				renewed = time.Now()
			case time.Since(renewed) >= lease-every:
				cancel()
				return
			}
		}
	}
}
