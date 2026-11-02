package qcache

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/supazd/supabi/internal/datasource"
)

// Mode is what a request wants from the cache.
type Mode string

const (
	// Default reads a kept result when there is one, and keeps a new one.
	Default Mode = "default"
	// Refresh asks the database again and keeps what it says.
	Refresh Mode = "refresh"
	// Bypass asks the database and keeps nothing, without joining anyone.
	Bypass Mode = "bypass"
)

func (m Mode) Valid() bool { return m == Default || m == Refresh || m == Bypass }

// MaxEntryBytes is the estimated size above which a result is not kept.
const MaxEntryBytes = 8 << 20

// Entry is what a database returned for a statement.
type Entry struct {
	// Result is shared by everyone who reads the entry and must not be changed.
	Result *datasource.Result
	// At is when the database returned it.
	At time.Time
	// Duration is how long the database took.
	Duration time.Duration
	// size is Size(Result), worked out once when the database answered; zero
	// when it was not.
	size int
}

// Started is when the statement began to run, queueing included: the data
// is no older than this.
func (e *Entry) Started() time.Time { return e.At.Add(-e.Duration) }

// Bytes is the estimated size of the entry in memory.
func (e *Entry) Bytes() int {
	if e.size > 0 {
		return e.size
	}
	return Size(e.Result)
}

// Store keeps entries for a while. Get returns nil, nil when there is none.
type Store interface {
	Get(ctx context.Context, key string) (*Entry, error)
	Set(ctx context.Context, key string, e *Entry, ttl time.Duration) error
}

// Outcome says how a result was come by.
type Outcome struct {
	*Entry
	// Hit is set when the result was kept from before.
	Hit bool
	// Shared is set when another request was already asking the database the
	// same thing, and this one waited for its answer.
	Shared bool
}

// Cache keeps results in a Store and merges identical statements that run at
// the same time. A nil store keeps nothing but still merges.
type Cache struct {
	store  Store
	logger *slog.Logger
	now    func() time.Time

	mu    sync.Mutex
	calls map[string]*call

	warned     time.Time
	suppressed int
}

type call struct {
	done    chan struct{}
	entry   *Entry
	err     error
	waiters int
	cancel  context.CancelFunc
}

func New(store Store, logger *slog.Logger) *Cache {
	return &Cache{store: store, logger: logger, now: time.Now, calls: map[string]*call{}}
}

// Do returns the result of the statement key stands for, from the store or
// from run. ttl is how long a new result is kept; zero keeps none.
func (c *Cache) Do(ctx context.Context, key string, mode Mode, ttl time.Duration, run func(context.Context) (*datasource.Result, error)) (Outcome, error) {
	return c.do(ctx, key, mode, 0, ttl, run)
}

// DoWithin is Do in Default mode for a result whose statement started less
// than maxAge ago. An older kept result is treated as a refresh would treat
// it: the statement runs again, joined by identical ones, and replaces it.
// Measuring from the start rather than the end means a result asked for
// again one maxAge later is never taken for fresh, however long it ran.
func (c *Cache) DoWithin(ctx context.Context, key string, maxAge, ttl time.Duration, run func(context.Context) (*datasource.Result, error)) (Outcome, error) {
	return c.do(ctx, key, Default, maxAge, ttl, run)
}

func (c *Cache) do(ctx context.Context, key string, mode Mode, maxAge, ttl time.Duration, run func(context.Context) (*datasource.Result, error)) (Outcome, error) {
	if mode == Bypass {
		entry, err := c.run(ctx, run)
		return Outcome{Entry: entry}, err
	}
	if mode == Default && c.store != nil && ttl > 0 {
		entry, err := c.store.Get(ctx, key)
		if err != nil {
			c.warn("read", err)
		} else if entry != nil && (maxAge <= 0 || c.now().Sub(entry.Started()) < maxAge) {
			return Outcome{Entry: entry, Hit: true}, nil
		}
	}

	c.mu.Lock()
	cl, shared := c.calls[key]
	if shared {
		cl.waiters++
	} else {
		cl = c.start(ctx, key, ttl, run)
	}
	c.mu.Unlock()

	select {
	case <-cl.done:
		return Outcome{Entry: cl.entry, Shared: shared}, cl.err
	case <-ctx.Done():
		c.mu.Lock()
		cl.waiters--
		// Nobody is left to read the answer. A request arriving after this
		// must start afresh rather than join a statement being cancelled.
		if cl.waiters == 0 {
			cl.cancel()
			c.forget(key, cl)
		}
		c.mu.Unlock()
		return Outcome{}, ctx.Err()
	}
}

// start runs the statement for everyone who will wait on key. It runs apart
// from the request that started it, which may leave before the others. The
// caller holds c.mu.
func (c *Cache) start(ctx context.Context, key string, ttl time.Duration, run func(context.Context) (*datasource.Result, error)) *call {
	shared := context.WithoutCancel(ctx)
	var cancel context.CancelFunc
	if deadline, ok := ctx.Deadline(); ok {
		shared, cancel = context.WithDeadline(shared, deadline)
	} else {
		shared, cancel = context.WithCancel(shared)
	}
	cl := &call{done: make(chan struct{}), waiters: 1, cancel: cancel}
	c.calls[key] = cl
	go func() {
		defer cancel()
		cl.entry, cl.err = c.run(shared, run)
		if cl.err == nil && c.store != nil && ttl > 0 && cl.entry.size <= MaxEntryBytes {
			if err := c.store.Set(shared, key, cl.entry, ttl); err != nil && !errors.Is(err, errUnkeepable) {
				c.warn("write", err)
			}
		}
		c.mu.Lock()
		c.forget(key, cl)
		c.mu.Unlock()
		close(cl.done)
	}()
	return cl
}

// forget stops new requests joining cl, unless another call for key has
// already taken its place. The caller holds c.mu.
func (c *Cache) forget(key string, cl *call) {
	if c.calls[key] == cl {
		delete(c.calls, key)
	}
}

func (c *Cache) run(ctx context.Context, run func(context.Context) (*datasource.Result, error)) (*Entry, error) {
	started := c.now()
	result, err := run(ctx)
	if err != nil {
		return nil, err
	}
	at := c.now()
	return &Entry{Result: result, At: at, Duration: at.Sub(started), size: Size(result)}, nil
}

// warnEvery is how often a failing store is reported: when it is down, every
// query fails to read it.
const warnEvery = 30 * time.Second

func (c *Cache) warn(op string, err error) {
	c.mu.Lock()
	now := c.now()
	if now.Sub(c.warned) < warnEvery {
		c.suppressed++
		c.mu.Unlock()
		return
	}
	suppressed := c.suppressed
	c.warned, c.suppressed = now, 0
	c.mu.Unlock()
	c.logger.Warn("query cache unavailable; asking the data source instead", "op", op, "error", err, "suppressed", suppressed)
}

// Size estimates how much memory a result takes.
func Size(r *datasource.Result) int {
	n := 64
	for _, col := range r.Columns {
		n += 48 + len(col.Name) + len(col.Type) + len(col.DBType)
	}
	for _, row := range r.Rows {
		n += 24 + 16*len(row)
		for _, v := range row {
			if s, ok := v.(string); ok {
				n += len(s)
			}
		}
	}
	return n
}
