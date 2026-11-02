package datasource

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// blockingStreamConn streams like blockingConn queries: held until released.
type blockingStreamConn struct{ *blockingConn }

func (c blockingStreamConn) Stream(ctx context.Context, sql string, args []any, _ RowWriter) error {
	_, err := c.Query(ctx, sql, args)
	return err
}

func TestExportStreamsLeaveSlotsForInteractiveQueries(t *testing.T) {
	inner := &blockingConn{release: make(chan struct{})}
	conn := Limit(blockingStreamConn{inner}, 4).(*limited)
	var wg sync.WaitGroup
	for range 2 {
		wg.Go(func() {
			if err := conn.Stream(context.Background(), "SELECT 1", nil, nil); err != nil {
				t.Error(err)
			}
		})
	}
	waitUntil(t, func() bool { return inner.running.Load() == 2 })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := conn.Stream(ctx, "SELECT 1", nil, nil); !errors.Is(err, ErrQueueTimeout) {
		t.Errorf("a third export on four slots: %v", err)
	}
	for range 2 {
		wg.Go(func() {
			if _, err := conn.Query(context.Background(), "SELECT 1", nil); err != nil {
				t.Error(err)
			}
		})
	}
	// Both interactive statements run beside the exports instead of queueing.
	waitUntil(t, func() bool { return inner.running.Load() == 4 })
	close(inner.release)
	wg.Wait()
}

func TestExportStreamsRunOnASingleSlot(t *testing.T) {
	inner := &blockingConn{release: make(chan struct{})}
	close(inner.release)
	if err := Limit(blockingStreamConn{inner}, 1).(*limited).Stream(context.Background(), "SELECT 1", nil, nil); err != nil {
		t.Fatal(err)
	}
}

// rowsConn streams the given rows, one fresh slice each, as drivers do.
type rowsConn struct{ rows [][]any }

func (c rowsConn) Stream(_ context.Context, _ string, _ []any, out RowWriter) error {
	if err := out.Start([]Column{{Name: "n", Type: Integer}}); err != nil {
		return err
	}
	for _, row := range c.rows {
		if err := out.WriteRow(row); err != nil {
			return err
		}
	}
	return nil
}

func TestCollectKeepsDriverRowsWithoutCopying(t *testing.T) {
	rows := [][]any{{int64(1)}, {int64(2)}}
	result, err := Collect(context.Background(), rowsConn{rows}, "SELECT n", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Rows) != 2 || &result.Rows[0][0] != &rows[0][0] || &result.Rows[1][0] != &rows[1][0] {
		t.Fatalf("rows were copied: %v", result.Rows)
	}
	empty, err := Collect(context.Background(), rowsConn{}, "SELECT n", nil)
	if err != nil || empty.Rows == nil || len(empty.Columns) != 1 {
		t.Fatalf("an empty result must still carry columns and a non-nil row list: %+v, %v", empty, err)
	}
}
