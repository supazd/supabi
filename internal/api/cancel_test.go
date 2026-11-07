package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"testing"
)

// A request its client left is answered without being taken for a fault,
// however deep the cancellation came from: .agents/design/query-ir.md 6.7.
func TestCancelledRequestIsNotAnError(t *testing.T) {
	var logged bytes.Buffer
	s := &Server{Logger: slog.New(slog.NewTextHandler(&logged, nil))}
	ctx := context.Background()
	cancelled := fmt.Errorf("run the statement: %w", context.Canceled)
	if e := s.toAPIError(ctx, s.databaseError(ctx, "ds_1", cancelled)); e.status != statusClientClosed || e.code != "canceled" {
		t.Errorf("cancelled: %d %s", e.status, e.code)
	}
	if code := errorCode(cancelled); code != "canceled" {
		t.Errorf("audited as %q, want canceled", code)
	}
	if logged.Len() != 0 {
		t.Errorf("a cancellation was logged: %s", logged.String())
	}
	// Anything else is still ours to fix, and logged.
	if e := s.toAPIError(ctx, errors.New("something broke")); e.status != 500 || !bytes.Contains(logged.Bytes(), []byte("level=ERROR")) {
		t.Errorf("other errors: %d, logged %q", e.status, logged.String())
	}
}
