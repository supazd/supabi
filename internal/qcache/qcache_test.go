package qcache

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/id"
)

func TestKeyTellsTypesAndPartsApart(t *testing.T) {
	at := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
	base := Key("src_1", "v1", "SELECT ?", []any{int64(1)})
	for name, other := range map[string]string{
		"string arg":   Key("src_1", "v1", "SELECT ?", []any{"1"}),
		"float arg":    Key("src_1", "v1", "SELECT ?", []any{1.0}),
		"other source": Key("src_2", "v1", "SELECT ?", []any{int64(1)}),
		"new version":  Key("src_1", "v2", "SELECT ?", []any{int64(1)}),
		"other sql":    Key("src_1", "v1", "SELECT ? ", []any{int64(1)}),
		"no args":      Key("src_1", "v1", "SELECT ?", nil),
		// Parts are length-prefixed, so moving text between them changes the key.
		"shifted": Key("src_1v", "1", "SELECT ?", []any{int64(1)}),
	} {
		if other == base {
			t.Errorf("%s: same key as the base", name)
		}
	}
	if Key("s", "v", "q", []any{at}) != Key("s", "v", "q", []any{at.Add(0)}) {
		t.Error("equal times give different keys")
	}
	// time.Now carries a monotonic reading that must not reach the key.
	now := time.Now()
	if Key("s", "v", "q", []any{now}) != Key("s", "v", "q", []any{now.Round(0)}) {
		t.Error("the monotonic clock reading is part of the key")
	}
	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	if Key("s", "v", "q", []any{at}) == Key("s", "v", "q", []any{at.In(shanghai)}) {
		t.Error("the same instant in another zone binds differently and needs another key")
	}
}

func sample() *datasource.Result {
	return &datasource.Result{
		Columns: []datasource.Column{{Name: "region", Type: datasource.String, DBType: "text"}, {Name: "n", Type: datasource.Integer, DBType: "int8"}},
		Rows: [][]any{
			{"华东", int64(math.MaxInt64)},
			{nil, int64(-3)},
			{"x", 2.5},
			{true, false},
		},
	}
}

func TestEncodeKeepsTypes(t *testing.T) {
	at := time.Date(2026, 10, 17, 9, 0, 0, 123, time.UTC)
	for _, rows := range []int{0, 1, 20000} {
		result := sample()
		for len(result.Rows) < rows {
			result.Rows = append(result.Rows, []any{strings.Repeat("长", 10), int64(len(result.Rows))})
		}
		if rows == 0 {
			result.Rows = nil
		}
		b, err := encode(&Entry{Result: result, At: at, Duration: 42 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		got, err := decode(b)
		if err != nil {
			t.Fatalf("%d rows: %v", rows, err)
		}
		if !got.At.Equal(at) || got.Duration != 42*time.Millisecond {
			t.Errorf("%d rows: at %v, duration %v", rows, got.At, got.Duration)
		}
		if len(got.Result.Rows) != len(result.Rows) || len(got.Result.Columns) != 2 || got.Result.Columns[1] != result.Columns[1] {
			t.Fatalf("%d rows: got %d rows, columns %v", rows, len(got.Result.Rows), got.Result.Columns)
		}
		for i, row := range result.Rows {
			for j, v := range row {
				if got.Result.Rows[i][j] != v {
					t.Fatalf("row %d col %d: got %#v, want %#v", i, j, got.Result.Rows[i][j], v)
				}
			}
		}
		if rows == 20000 && b[2] != flagCompressed {
			t.Error("a large entry was not compressed")
		}
	}
}

func TestDecodeRefusesDamage(t *testing.T) {
	b, err := encode(&Entry{Result: sample(), At: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for n := range len(b) {
		if _, err := decode(b[:n]); err == nil {
			t.Fatalf("decoded a truncated entry of %d bytes", n)
		}
	}
	if _, err := encode(&Entry{Result: &datasource.Result{Rows: [][]any{{time.Now()}}}}); !errors.Is(err, errUnkeepable) {
		t.Errorf("an unknown value type: %v", err)
	}
}

func TestMemoryEvictsLeastRecentlyUsed(t *testing.T) {
	entry := &Entry{Result: sample()}
	size := int64(Size(entry.Result))
	m := NewMemory(3 * size)
	ctx := context.Background()
	for _, key := range []string{"a", "b", "c"} {
		_ = m.Set(ctx, key, entry, time.Hour)
	}
	if got, _ := m.Get(ctx, "a"); got == nil {
		t.Fatal("a is missing")
	}
	_ = m.Set(ctx, "d", entry, time.Hour)
	if got, _ := m.Get(ctx, "b"); got != nil {
		t.Error("b, the least recently used, was kept")
	}
	for _, key := range []string{"a", "c", "d"} {
		if got, _ := m.Get(ctx, key); got == nil {
			t.Errorf("%s was dropped", key)
		}
	}
	if m.used != 3*size {
		t.Errorf("used %d, want %d", m.used, 3*size)
	}

	tiny := NewMemory(size - 1)
	_ = tiny.Set(ctx, "a", entry, time.Hour)
	if got, _ := tiny.Get(ctx, "a"); got != nil || tiny.used != 0 {
		t.Error("an entry larger than the whole cache was kept")
	}
}

// stores runs a test against every store there is to test: Redis only when
// SUPABI_TEST_REDIS_URL names one.
func stores(t *testing.T, test func(t *testing.T, store Store, advance func(time.Duration))) {
	t.Run("memory", func(t *testing.T) {
		m := NewMemory(1 << 20)
		now := time.Now()
		m.now = func() time.Time { return now }
		test(t, m, func(d time.Duration) { now = now.Add(d) })
	})
	t.Run("redis", func(t *testing.T) {
		url := os.Getenv("SUPABI_TEST_REDIS_URL")
		if url == "" {
			t.Skip("SUPABI_TEST_REDIS_URL is not set")
		}
		r, err := NewRedis(url, "supabi-test:"+id.New("t")+":")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = r.Close() })
		if err := r.Ping(context.Background()); err != nil {
			t.Fatal(err)
		}
		test(t, r, func(d time.Duration) { time.Sleep(d) })
	})
}

func TestStoresKeepUntilExpiry(t *testing.T) {
	stores(t, func(t *testing.T, store Store, advance func(time.Duration)) {
		ctx := context.Background()
		at := time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC)
		if got, err := store.Get(ctx, "missing"); got != nil || err != nil {
			t.Fatalf("missing key: %v, %v", got, err)
		}
		if err := store.Set(ctx, "k", &Entry{Result: sample(), At: at, Duration: time.Second}, 300*time.Millisecond); err != nil {
			t.Fatal(err)
		}
		got, err := store.Get(ctx, "k")
		if err != nil || got == nil {
			t.Fatalf("kept entry: %v, %v", got, err)
		}
		if !got.At.Equal(at) || got.Duration != time.Second || got.Result.Rows[0][1] != int64(math.MaxInt64) {
			t.Errorf("kept entry changed: %+v", got)
		}
		advance(400 * time.Millisecond)
		if got, err := store.Get(ctx, "k"); got != nil || err != nil {
			t.Errorf("expired entry: %v, %v", got, err)
		}
	})
}

func newCache(store Store) *Cache {
	return New(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestDoReadsKeepsAndRefreshes(t *testing.T) {
	stores(t, func(t *testing.T, store Store, _ func(time.Duration)) {
		c := newCache(store)
		ctx := context.Background()
		var runs atomic.Int32
		run := func(context.Context) (*datasource.Result, error) {
			runs.Add(1)
			return sample(), nil
		}
		first, err := c.Do(ctx, "k", Default, time.Minute, run)
		if err != nil || first.Hit || runs.Load() != 1 {
			t.Fatalf("first: %+v, %v, runs %d", first, err, runs.Load())
		}
		second, err := c.Do(ctx, "k", Default, time.Minute, run)
		if err != nil || !second.Hit || runs.Load() != 1 || !second.At.Equal(first.At) {
			t.Fatalf("second: %+v, %v, runs %d", second, err, runs.Load())
		}
		refreshed, err := c.Do(ctx, "k", Refresh, time.Minute, run)
		if err != nil || refreshed.Hit || runs.Load() != 2 {
			t.Fatalf("refresh: %+v, %v, runs %d", refreshed, err, runs.Load())
		}
		after, _ := c.Do(ctx, "k", Default, time.Minute, run)
		if !after.Hit || !after.At.Equal(refreshed.At) {
			t.Error("a refresh did not replace what was kept")
		}
		bypassed, _ := c.Do(ctx, "k", Bypass, time.Minute, run)
		if bypassed.Hit || runs.Load() != 3 {
			t.Error("bypass read the cache")
		}
		// No time to keep: run every time.
		_, _ = c.Do(ctx, "fresh", Default, 0, run)
		_, _ = c.Do(ctx, "fresh", Default, 0, run)
		if runs.Load() != 5 {
			t.Errorf("a data source that keeps nothing: %d runs", runs.Load())
		}
	})
}

func TestDoWithinRefreshesWhatStartedTooLongAgo(t *testing.T) {
	stores(t, func(t *testing.T, store Store, _ func(time.Duration)) {
		c := newCache(store)
		start := time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)
		now := start
		c.now = func() time.Time { return now }
		ctx := context.Background()
		var runs atomic.Int32
		// Each run takes ten seconds of the cache's clock.
		run := func(context.Context) (*datasource.Result, error) {
			runs.Add(1)
			now = now.Add(10 * time.Second)
			return sample(), nil
		}
		first, err := c.DoWithin(ctx, "k", time.Minute, time.Hour, run)
		if err != nil || first.Hit || runs.Load() != 1 || !first.Started().Equal(start) {
			t.Fatalf("first: %+v, %v, runs %d", first, err, runs.Load())
		}
		now = start.Add(59 * time.Second)
		if young, _ := c.DoWithin(ctx, "k", time.Minute, time.Hour, run); !young.Hit || runs.Load() != 1 {
			t.Fatalf("a result started 59s ago was not used: %+v, runs %d", young, runs.Load())
		}
		// Fifty seconds after it came back, but a minute after it started: too old.
		now = start.Add(time.Minute)
		old, err := c.DoWithin(ctx, "k", time.Minute, time.Hour, run)
		if err != nil || old.Hit || runs.Load() != 2 {
			t.Fatalf("a result started a minute ago was used: %+v, %v, runs %d", old, err, runs.Load())
		}
		if kept, _ := c.Do(ctx, "k", Default, time.Hour, run); !kept.Hit || !kept.At.Equal(old.At) {
			t.Error("the newer result did not replace the kept one")
		}
	})
}

func TestDoDoesNotKeepErrors(t *testing.T) {
	c := newCache(NewMemory(1 << 20))
	failing := errors.New("boom")
	var runs int
	run := func(context.Context) (*datasource.Result, error) {
		runs++
		if runs == 1 {
			return nil, failing
		}
		return sample(), nil
	}
	if _, err := c.Do(context.Background(), "k", Default, time.Minute, run); !errors.Is(err, failing) {
		t.Fatalf("got %v", err)
	}
	if out, err := c.Do(context.Background(), "k", Default, time.Minute, run); err != nil || out.Hit {
		t.Fatalf("after an error: %+v, %v", out, err)
	}
}

func TestDoMergesIdenticalStatements(t *testing.T) {
	c := newCache(nil)
	release := make(chan struct{})
	var runs atomic.Int32
	run := func(context.Context) (*datasource.Result, error) {
		runs.Add(1)
		<-release
		return sample(), nil
	}
	var wg sync.WaitGroup
	outcomes := make([]Outcome, 5)
	for i := range outcomes {
		wg.Go(func() {
			outcomes[i], _ = c.Do(context.Background(), "k", Default, time.Minute, run)
		})
	}
	waitFor(t, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.calls["k"] != nil && c.calls["k"].waiters == 5
	})
	close(release)
	wg.Wait()
	shared := 0
	for _, o := range outcomes {
		if o.Entry == nil {
			t.Fatal("a request got no result")
		}
		if o.Shared {
			shared++
		}
	}
	if runs.Load() != 1 || shared != 4 {
		t.Errorf("runs %d, shared %d", runs.Load(), shared)
	}
}

func TestDoCancelsOnlyWhenEveryoneLeft(t *testing.T) {
	c := newCache(nil)
	cancelled := make(chan struct{})
	release := make(chan struct{})
	run := func(ctx context.Context) (*datasource.Result, error) {
		select {
		case <-ctx.Done():
			close(cancelled)
			return nil, ctx.Err()
		case <-release:
			return sample(), nil
		}
	}
	firstCtx, leaveFirst := context.WithCancel(context.Background())
	secondCtx, leaveSecond := context.WithCancel(context.Background())
	errs := make(chan error, 2)
	go func() { _, err := c.Do(firstCtx, "k", Default, time.Minute, run); errs <- err }()
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.calls["k"] != nil })
	go func() { _, err := c.Do(secondCtx, "k", Default, time.Minute, run); errs <- err }()
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.calls["k"].waiters == 2 })

	leaveFirst()
	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Fatalf("the one who left: %v", err)
	}
	select {
	case <-cancelled:
		t.Fatal("the statement was cancelled while someone still waited")
	case <-time.After(50 * time.Millisecond):
	}
	leaveSecond()
	<-errs
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("the statement kept running after everyone left")
	}
}

func TestDoReadsThroughABrokenStore(t *testing.T) {
	c := newCache(brokenStore{})
	var runs int
	run := func(context.Context) (*datasource.Result, error) { runs++; return sample(), nil }
	for range 3 {
		if _, err := c.Do(context.Background(), "k", Default, time.Minute, run); err != nil {
			t.Fatal(err)
		}
	}
	if runs != 3 {
		t.Errorf("runs %d", runs)
	}
	if c.suppressed == 0 {
		t.Error("every failure was logged")
	}
}

type brokenStore struct{}

func (brokenStore) Get(context.Context, string) (*Entry, error) { return nil, errors.New("down") }
func (brokenStore) Set(context.Context, string, *Entry, time.Duration) error {
	return errors.New("down")
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(time.Millisecond)
	}
}

// A request that arrives while a statement everyone left is still winding
// down starts its own, rather than joining one that was cancelled.
func TestDoStartsAfreshAfterEveryoneLeft(t *testing.T) {
	c := newCache(nil)
	hold := make(chan struct{})
	first := func(ctx context.Context) (*datasource.Result, error) {
		<-hold // slow to notice the cancellation
		return nil, ctx.Err()
	}
	ctx, leave := context.WithCancel(context.Background())
	errs := make(chan error, 1)
	go func() { _, err := c.Do(ctx, "k", Default, time.Minute, first); errs <- err }()
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return c.calls["k"] != nil })
	leave()
	<-errs

	out, err := c.Do(context.Background(), "k", Default, time.Minute, func(context.Context) (*datasource.Result, error) { return sample(), nil })
	if err != nil || out.Shared || out.Entry == nil {
		t.Fatalf("after everyone left: %+v, %v", out, err)
	}
	close(hold)
	// The cancelled call finishing must not remove a call that took its place.
	waitFor(t, func() bool { c.mu.Lock(); defer c.mu.Unlock(); return len(c.calls) == 0 })
}
