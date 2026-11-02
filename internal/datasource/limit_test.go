package datasource

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// blockingConn holds every statement until released, counting how many run at once.
type blockingConn struct {
	Conn
	release chan struct{}
	running atomic.Int32
	most    atomic.Int32
}

func (c *blockingConn) Query(ctx context.Context, _ string, _ []any) (*Result, error) {
	n := c.running.Add(1)
	defer c.running.Add(-1)
	for {
		most := c.most.Load()
		if n <= most || c.most.CompareAndSwap(most, n) {
			break
		}
	}
	select {
	case <-c.release:
		return &Result{}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestLimitRunsAtMostN(t *testing.T) {
	inner := &blockingConn{release: make(chan struct{})}
	conn := Limit(inner, 2).(*limited)
	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			if _, err := conn.Query(context.Background(), "SELECT 1", nil); err != nil {
				t.Error(err)
			}
		})
	}
	waitUntil(t, func() bool { conn.mu.Lock(); defer conn.mu.Unlock(); return conn.waiting == 3 })
	if inner.running.Load() != 2 {
		t.Errorf("%d statements running", inner.running.Load())
	}
	close(inner.release)
	wg.Wait()
	if inner.most.Load() != 2 {
		t.Errorf("at most %d ran at once", inner.most.Load())
	}
}

func TestLimitRefusesBeyondTheQueue(t *testing.T) {
	inner := &blockingConn{release: make(chan struct{})}
	conn := Limit(inner, 1).(*limited)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var wg sync.WaitGroup
	for range 1 + MaxQueued {
		wg.Go(func() { _, _ = conn.Query(ctx, "SELECT 1", nil) })
	}
	waitUntil(t, func() bool { conn.mu.Lock(); defer conn.mu.Unlock(); return conn.waiting == MaxQueued })
	if _, err := conn.Query(ctx, "SELECT 1", nil); !errors.Is(err, ErrBusy) {
		t.Errorf("one more than the queue holds: %v", err)
	}
	cancel()
	wg.Wait()
}

func TestLimitReportsTimingOutInTheQueue(t *testing.T) {
	inner := &blockingConn{release: make(chan struct{})}
	conn := Limit(inner, 1)
	go func() { _, _ = conn.Query(context.Background(), "SELECT 1", nil) }()
	waitUntil(t, func() bool { return inner.running.Load() == 1 })

	ctx, stats := WithStats(context.Background())
	ctx, cancel := context.WithTimeout(ctx, 30*time.Millisecond)
	defer cancel()
	if _, err := conn.Query(ctx, "SELECT 1", nil); !errors.Is(err, ErrQueueTimeout) {
		t.Errorf("timing out while waiting: %v", err)
	}
	if stats.Queued() < 20*time.Millisecond {
		t.Errorf("queued for %v", stats.Queued())
	}
	close(inner.release)
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}
