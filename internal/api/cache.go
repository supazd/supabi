package api

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/qcache"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/source"
	"github.com/supazd/supabi/internal/store"
)

func maxConcurrentQueries(d store.Datasource) int { return source.MaxConcurrent(d) }
func datasourceVersion(d store.Datasource) string { return source.Version(d) }

// cacheTTL is how long results from a data source are kept: its own
// setting, else the system's (.agents/design/configuration.md 10.2).
func (s *Server) cacheTTL(ctx context.Context, d store.Datasource, settings store.SystemSettings) (time.Duration, error) {
	if d.CacheTTLSeconds != nil {
		return time.Duration(*d.CacheTTLSeconds) * time.Second, nil
	}
	if s.CacheTTL != nil {
		return s.CacheTTL(ctx)
	}
	return settings.QueryCacheTTL, nil
}

// withQueryTimeout bounds what is done on a data source by the system's
// setting, read anew so that a change applies at once on every instance.
func (s *Server) withQueryTimeout(ctx context.Context) (context.Context, context.CancelFunc, error) {
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, settings.QueryTimeout)
	return ctx, cancel, nil
}

type cacheModeKey struct{}

// withCacheMode says what the queries run for a request want from the cache.
func withCacheMode(ctx context.Context, mode qcache.Mode) context.Context {
	return context.WithValue(ctx, cacheModeKey{}, mode)
}

// withRefresh is withCacheMode for a request that may ask for fresh data.
func withRefresh(ctx context.Context, refresh *bool) context.Context {
	if refresh != nil && *refresh {
		return withCacheMode(ctx, qcache.Refresh)
	}
	return ctx
}

type cacheMaxAgeKey struct{}

// maxAgeLimit is the most a request may say it accepts, a day: no kept result lives longer.
const maxAgeLimit = 86400

// withFreshness is withRefresh for a request that may instead accept a kept
// result whose statement started less than maxAge seconds ago, as a dashboard's
// timed refresh does (.agents/design/query-ir.md §6.6).
func withFreshness(ctx context.Context, refresh *bool, maxAge *int) (context.Context, error) {
	if maxAge == nil {
		return withRefresh(ctx, refresh), nil
	}
	if refresh != nil && *refresh {
		return nil, badRequest("invalid_request", "maxAge cannot be combined with refresh")
	}
	return withMaxAge(ctx, *maxAge)
}

func withMaxAge(ctx context.Context, seconds int) (context.Context, error) {
	if seconds < 1 || seconds > maxAgeLimit {
		return nil, badRequest("invalid_request", "maxAge must be between 1 and 86400 seconds")
	}
	return context.WithValue(ctx, cacheMaxAgeKey{}, time.Duration(seconds)*time.Second), nil
}

func maxAgeFrom(ctx context.Context) time.Duration {
	maxAge, _ := ctx.Value(cacheMaxAgeKey{}).(time.Duration)
	return maxAge
}

func cacheModeFrom(ctx context.Context) qcache.Mode {
	if mode, ok := ctx.Value(cacheModeKey{}).(qcache.Mode); ok {
		return mode
	}
	return qcache.Default
}

// fetch runs a compiled query on a data source, or answers it from the query
// cache. The key is the statement as compiled, data permissions included, so
// a result is shared only by people who would have run the same statement.
func (s *Server) fetch(ctx context.Context, source store.Datasource, conn datasource.Conn, c *query.Compiled, settings store.SystemSettings) (*query.Result, qcache.Outcome, error) {
	key := qcache.Key(source.ID, datasourceVersion(source), c.SQL, c.Args)
	ttl, err := s.cacheTTL(ctx, source, settings)
	if err != nil {
		return nil, qcache.Outcome{}, err
	}
	var queued atomic.Int64
	run := func(ctx context.Context) (*datasource.Result, error) {
		ctx, stats := datasource.WithStats(ctx)
		defer func() { queued.Store(int64(stats.Queued())) }()
		return conn.Query(ctx, c.SQL, c.Args)
	}
	mode, maxAge := cacheModeFrom(ctx), maxAgeFrom(ctx)
	var out qcache.Outcome
	if mode == qcache.Default && maxAge > 0 {
		out, err = s.Cache.DoWithin(ctx, key, maxAge, ttl, run)
	} else {
		out, err = s.Cache.Do(ctx, key, mode, ttl, run)
	}
	attrs := []any{"datasource", source.ID, "key", key[:12], "mode", mode, "hit", out.Hit, "shared", out.Shared, "queuedMs", time.Duration(queued.Load()).Milliseconds()}
	if maxAge > 0 {
		attrs = append(attrs, "maxAgeS", int(maxAge.Seconds()))
	}
	if err != nil {
		s.Logger.InfoContext(ctx, "query", append(attrs, "error", err)...)
		return nil, out, err
	}
	s.Logger.InfoContext(ctx, "query", append(attrs, "durationMs", out.Duration.Milliseconds(), "rows", len(out.Result.Rows))...)
	result := query.Shape(c, out.Result)
	result.Meta.DurationMs = out.Duration.Milliseconds()
	return result, out, nil
}
