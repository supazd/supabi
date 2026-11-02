package exports

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/blob/blobtest"
	"github.com/supazd/supabi/internal/datasource"
)

// endlessConn streams rows until the writer refuses one, then reports what a
// driver would see while closing its result.
type endlessConn struct {
	columns        int
	cancelledAtEnd bool
}

func (c *endlessConn) Stream(ctx context.Context, _ string, _ []any, out datasource.RowWriter) error {
	columns := make([]datasource.Column, c.columns)
	row := make([]any, c.columns)
	for i := range columns {
		columns[i] = datasource.Column{Name: "c" + strconv.Itoa(i), Type: datasource.String}
		row[i] = "v" + strconv.Itoa(i)
	}
	err := out.Start(columns)
	for err == nil {
		err = out.WriteRow(row)
	}
	c.cancelledAtEnd = ctx.Err() != nil
	// Some drivers report the cancellation instead of the writer's error.
	return ctx.Err()
}

func TestStreamStopsTheQueryWhenTheWriterFails(t *testing.T) {
	cases := []struct {
		name, format string
		columns      int
		maxRows      int64
		maxBytes     int64
		want         error
	}{
		{"too many columns", "xlsx", sheetColumns + 1, 10, 1 << 20, ErrColumnLimit},
		{"file too large", "csv", 1, 1_000_000, 1 << 10, ErrFileLimit},
		{"too many rows", "csv", 1, 3, 1 << 20, ErrRowLimit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, err := NewWriter(discard{}, tc.format, tc.maxRows, tc.maxBytes)
			if err != nil {
				t.Fatal(err)
			}
			conn := &endlessConn{columns: tc.columns}
			var progress atomic.Int64
			if err := streamTo(context.Background(), conn, "SELECT", nil, view{}, w, &progress); !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
			if !conn.cancelledAtEnd {
				t.Fatal("the query kept running after the writer failed")
			}
		})
	}
}

// A chart's view writes only its shown columns, under the page's headings,
// and stops the query once the chart's own row limit is written.
func TestStreamWritesAChartsViewUpToItsLimit(t *testing.T) {
	var out bytes.Buffer
	w, err := NewWriter(&out, "csv", 100, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	conn := &endlessConn{columns: 3}
	var progress atomic.Int64
	v := view{picks: []int{2, 0}, headers: []string{"第三列", "第一列"}, limit: 2}
	if err := streamTo(context.Background(), conn, "SELECT", nil, v, w, &progress); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if !conn.cancelledAtEnd {
		t.Fatal("the query kept running after the limit")
	}
	if got, want := out.String(), "\ufeff第三列,第一列\nv2,v0\nv2,v0\n"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if progress.Load() != 2 {
		t.Fatalf("progress %d", progress.Load())
	}
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// The orphan sweep keeps published files and what live attempts are writing,
// in either kind of store, and removes the rest of the org's old files.
func TestSweepKeepsPublishedFilesAndLiveAttempts(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		ctx := context.Background()
		s := &Service{Files: files}
		write := func(key string, size int, commit bool) blob.Writer {
			t.Helper()
			w, err := files.Create(ctx, key, int64(size))
			if err != nil {
				t.Fatal(err)
			}
			if _, err = w.Write(bytes.Repeat([]byte("x"), size)); err != nil {
				t.Fatal(err)
			}
			if commit {
				if err = w.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			return w
		}
		published := "org/ws/exp_1/run_1/result.csv"
		write(published, 1, true)
		// A live attempt that already wrote a file, as one whose finish the
		// database has yet to commit, and one still writing.
		write("org/ws/exp_2/run_2/result.csv", 1, true)
		live := write("org/ws/exp_3/run_3/result.xlsx", 6<<20, false)
		defer live.Abort()
		// What failed attempts and crashed workers left.
		write("org/ws/exp_1/run_0/result.csv", 1, true)
		write("org/ws/exp_4/run_4/result.csv", 6<<20, false)
		other := "other/ws/exp_5/run_5/result.csv"
		write(other, 1, true)

		referenced, attempts := map[string]bool{published: true}, map[string]bool{"org/ws/exp_2/run_2": true, "org/ws/exp_3/run_3": true}
		if err := s.sweep(ctx, "org", referenced, attempts, time.Now().Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if err := live.Commit(ctx); err != nil {
			t.Fatalf("a live attempt's upload was swept: %v", err)
		}
		got := blobtest.Keys(t, files, "")
		want := []string{published, "org/ws/exp_2/run_2/result.csv", "org/ws/exp_3/run_3/result.xlsx", other}
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Fatalf("after the sweep: %v, want %v", got, want)
		}
	})
}
