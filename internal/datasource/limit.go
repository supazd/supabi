package datasource

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	// ErrBusy is returned at once when too many statements already wait for
	// a data source.
	ErrBusy = errors.New("too many queries are waiting for the data source")
	// ErrQueueTimeout is a statement that ran out of time before the data
	// source had room for it, as opposed to one the database was slow to answer.
	ErrQueueTimeout = errors.New("timed out waiting for the data source to have room")
)

// MaxQueued is how many statements may wait for one data source.
const MaxQueued = 100

// Stats records what happened to the statements run with a context made by
// WithStats.
type Stats struct {
	mu     sync.Mutex
	queued time.Duration
}

// Queued is how long the statements waited for room.
func (s *Stats) Queued() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.queued
}

type statsKey struct{}

func WithStats(ctx context.Context) (context.Context, *Stats) {
	s := &Stats{}
	return context.WithValue(ctx, statsKey{}, s), s
}

// limited lets at most a fixed number of statements run on a connection at
// once. The rest wait their turn, first come first served, up to MaxQueued.
type limited struct {
	Conn
	slots chan struct{}
	// streams admits exports to at most half of the slots: they hold one for
	// minutes, and interactive statements must keep room to run.
	streams chan struct{}

	mu      sync.Mutex
	waiting int
}

// Limit wraps conn so that at most n statements run on it at once.
func Limit(conn Conn, n int) Conn {
	n = max(n, 1)
	return &limited{Conn: conn, slots: make(chan struct{}, n), streams: make(chan struct{}, max(n/2, 1))}
}

func (l *limited) acquire(ctx context.Context) (release func(), err error) {
	select {
	case l.slots <- struct{}{}:
		return l.release, nil
	default:
	}
	l.mu.Lock()
	if l.waiting >= MaxQueued {
		l.mu.Unlock()
		return nil, ErrBusy
	}
	l.waiting++
	l.mu.Unlock()
	started := time.Now()
	defer func() {
		l.mu.Lock()
		l.waiting--
		l.mu.Unlock()
		if s, ok := ctx.Value(statsKey{}).(*Stats); ok {
			s.mu.Lock()
			s.queued += time.Since(started)
			s.mu.Unlock()
		}
	}()
	select {
	case l.slots <- struct{}{}:
		return l.release, nil
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrQueueTimeout
		}
		return nil, ctx.Err()
	}
}

func (l *limited) release() { <-l.slots }

func (l *limited) Query(ctx context.Context, sql string, args []any) (*Result, error) {
	release, err := l.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return l.Conn.Query(ctx, sql, args)
}

func (l *limited) Describe(ctx context.Context, sql string, args []any) ([]Column, error) {
	release, err := l.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return l.Conn.Describe(ctx, sql, args)
}

func (l *limited) Tables(ctx context.Context) ([]Table, error) {
	release, err := l.acquire(ctx)
	if err != nil {
		return nil, err
	}
	defer release()
	return l.Conn.Tables(ctx)
}
