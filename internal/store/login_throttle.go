package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// LoginThrottle slows down password guessing: after Max failures for one
// email address within Window of the first, it refuses further attempts
// until the window has passed. The count is kept in the metadata database,
// so every api instance shares it, and time is the database's, so instances
// with different clocks agree.
type LoginThrottle struct {
	Pool   *pgxpool.Pool
	Max    int
	Window time.Duration
}

// Attempt counts an attempt for the address, as a failure until Succeed
// clears it, and reports whether it may go ahead: not when the window
// already holds Max. It is counted before the password is checked, in one
// statement, so attempts made at the same time cannot all pass the check
// before any is counted. A refused attempt is not counted, so the window
// still ends Window after its first failure. A window that has passed
// starts a new one. See .agents/design/access-control.md 13.
func (l *LoginThrottle) Attempt(ctx context.Context, orgID, email string) (bool, error) {
	var failures int
	err := l.Pool.QueryRow(ctx, `INSERT INTO login_throttle AS t(org_id,email,failures,window_start) VALUES($1,$2,1,now())
 ON CONFLICT(org_id,email) DO UPDATE SET
 failures=CASE WHEN t.window_start>now()-make_interval(secs=>$3) THEN t.failures+1 ELSE 1 END,
 window_start=CASE WHEN t.window_start>now()-make_interval(secs=>$3) THEN t.window_start ELSE now() END
 WHERE t.window_start<=now()-make_interval(secs=>$3) OR t.failures<$4
 RETURNING failures`,
		orgID, email, l.Window.Seconds(), l.Max).Scan(&failures)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Succeed forgets the failures of the address.
func (l *LoginThrottle) Succeed(ctx context.Context, orgID, email string) error {
	_, err := l.Pool.Exec(ctx, `DELETE FROM login_throttle WHERE org_id=$1 AND email=$2`, orgID, email)
	return err
}

// PruneLoginThrottle forgets failures from more than a day ago, far longer
// than any window, so that addresses tried once do not pile up.
func PruneLoginThrottle(ctx context.Context, pool *pgxpool.Pool, orgID string) error {
	_, err := pool.Exec(ctx, `DELETE FROM login_throttle WHERE org_id=$1 AND window_start<now()-interval '1 day'`, orgID)
	return err
}
