package qcache

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// redisTimeout bounds each read and write: a slow cache must not make a query
// slower than asking the database would.
const redisTimeout = 200 * time.Millisecond

// Redis keeps entries in a Redis that every instance shares. Redis itself
// bounds the total size (maxmemory) and expires each entry.
type Redis struct {
	client *redis.Client
	prefix string
}

// NewRedis connects lazily: Redis being down when the process starts is the
// same as it going down later, and neither stops queries.
func NewRedis(url, prefix string) (*Redis, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	opt.DialTimeout = time.Second
	opt.ReadTimeout = redisTimeout
	opt.WriteTimeout = redisTimeout
	// A failed attempt is reported as a miss; retrying would only wait longer.
	opt.MaxRetries = -1
	return &Redis{client: redis.NewClient(opt), prefix: prefix + "qc:"}, nil
}

func (r *Redis) Get(ctx context.Context, key string) (*Entry, error) {
	ctx, cancel := context.WithTimeout(ctx, redisTimeout)
	defer cancel()
	b, err := r.client.Get(ctx, r.prefix+key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decode(b)
}

func (r *Redis) Set(ctx context.Context, key string, e *Entry, ttl time.Duration) error {
	b, err := encode(e)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, redisTimeout)
	defer cancel()
	return r.client.Set(ctx, r.prefix+key, b, ttl).Err()
}

// Ping says whether Redis answers, for reporting at startup.
func (r *Redis) Ping(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	return r.client.Ping(ctx).Err()
}

func (r *Redis) Close() error { return r.client.Close() }
