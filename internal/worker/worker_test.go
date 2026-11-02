package worker

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func runKeepLease(beat func() (bool, error)) (cancelled bool, elapsed time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var called atomic.Bool
	started := time.Now()
	stopped := make(chan struct{})
	timer := time.AfterFunc(time.Second, func() { close(stopped) })
	defer timer.Stop()
	keepLease(ctx, stopped, func() { called.Store(true); cancel() }, 10*time.Millisecond, 100*time.Millisecond, beat)
	return called.Load(), time.Since(started)
}

func TestKeepLeaseRetriesFailedRenewals(t *testing.T) {
	var beats atomic.Int32
	// Every other renewal fails: the lease never lapses, so the job keeps running.
	cancelled, _ := runKeepLease(func() (bool, error) {
		if beats.Add(1)%2 == 0 {
			return false, errors.New("connection reset")
		}
		return true, nil
	})
	if cancelled {
		t.Fatal("a transient renewal failure stopped the job")
	}
	if beats.Load() < 10 {
		t.Fatalf("only %d renewals", beats.Load())
	}
}

func TestKeepLeaseStopsWhenTheLeaseCannotBeRenewed(t *testing.T) {
	cancelled, elapsed := runKeepLease(func() (bool, error) { return false, errors.New("database down") })
	if !cancelled || elapsed < 80*time.Millisecond || elapsed > 500*time.Millisecond {
		t.Fatalf("cancelled=%v after %v", cancelled, elapsed)
	}
}

func TestKeepLeaseStopsAtOnceWhenRefused(t *testing.T) {
	cancelled, elapsed := runKeepLease(func() (bool, error) { return false, nil })
	if !cancelled || elapsed > 80*time.Millisecond {
		t.Fatalf("cancelled=%v after %v", cancelled, elapsed)
	}
}
