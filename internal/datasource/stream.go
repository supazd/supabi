package datasource

import (
	"context"
	"errors"
)

// RowWriter consumes a result. Start is called once, including for empty
// results. Drivers pass a fresh slice to each WriteRow, which may keep it.
type RowWriter interface {
	Start([]Column) error
	WriteRow([]any) error
}

// StreamingConn supports bounded-memory exports through the same read-only
// connection and concurrency limits as interactive queries.
type StreamingConn interface {
	Stream(context.Context, string, []any, RowWriter) error
}

type collector struct{ Result }

func (c *collector) Start(columns []Column) error {
	c.Columns, c.Rows = columns, [][]any{}
	return nil
}
func (c *collector) WriteRow(row []any) error {
	c.Rows = append(c.Rows, row)
	return nil
}

// Collect keeps the existing Query contract on top of streaming drivers.
func Collect(ctx context.Context, conn StreamingConn, sql string, args []any) (*Result, error) {
	var out collector
	err := conn.Stream(ctx, sql, args, &out)
	return &out.Result, err
}

func (l *limited) Stream(ctx context.Context, sql string, args []any, out RowWriter) error {
	// Exports wait for each other outside the shared queue, which is sized
	// for interactive statements.
	select {
	case l.streams <- struct{}{}:
		defer func() { <-l.streams }()
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return ErrQueueTimeout
		}
		return ctx.Err()
	}
	release, err := l.acquire(ctx)
	if err != nil {
		return err
	}
	defer release()
	stream, ok := l.Conn.(StreamingConn)
	if !ok {
		return &QueryError{Message: "this data source does not support streaming exports"}
	}
	return stream.Stream(ctx, sql, args, out)
}
