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

// Allow reports whether another attempt may be made for the address.
func (l *LoginThrottle) Allow(ctx context.Context, orgID, email string) (bool, error) {
	var failures int
	err := l.Pool.QueryRow(ctx, `SELECT failures FROM login_throttle WHERE org_id=$1 AND email=$2 AND window_start>now()-make_interval(secs=>$3)`,
		orgID, email, l.Window.Seconds()).Scan(&failures)
	if errors.Is(err, pgx.ErrNoRows) {
		return true, nil
	}
	return err == nil && failures < l.Max, err
}

// Fail records a failed attempt, in a new window if the last one has passed.
func (l *LoginThrottle) Fail(ctx context.Context, orgID, email string) error {
	_, err := l.Pool.Exec(ctx, `INSERT INTO login_throttle AS t(org_id,email,failures,window_start) VALUES($1,$2,1,now())
 ON CONFLICT(org_id,email) DO UPDATE SET
 failures=CASE WHEN t.window_start>now()-make_interval(secs=>$3) THEN t.failures+1 ELSE 1 END,
 window_start=CASE WHEN t.window_start>now()-make_interval(secs=>$3) THEN t.window_start ELSE now() END`,
		orgID, email, l.Window.Seconds())
	return err
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
