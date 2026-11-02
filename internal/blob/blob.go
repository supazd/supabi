// Package blob keeps files under keys such as org/workspace/export/run/result.csv,
// in a local directory or an S3 bucket. Callers do not know which.
package blob

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"time"
)

var ErrInvalidKey = errors.New("invalid file key")

// Store keeps files under keys. A missing file is reported as fs.ErrNotExist.
type Store interface {
	// Create starts writing the file at key, of at most maxSize bytes.
	// Nothing is at key until the writer is committed. ctx also bounds the
	// uploads done while writing.
	Create(ctx context.Context, key string, maxSize int64) (Writer, error)
	// Open opens the file at key for reading.
	Open(ctx context.Context, key string) (File, error)
	// Remove deletes the file at key. A missing file is not an error.
	Remove(ctx context.Context, key string) error
	// Sweep deletes what is below prefix and was last written before cutoff:
	// files, and writes left unfinished, unless keep says to keep its key.
	// What another sweep removed at the same time is not an error. An empty
	// prefix sweeps everything.
	Sweep(ctx context.Context, prefix string, cutoff time.Time, keep func(key string) bool) error
}

// Writer is a file being written.
type Writer interface {
	io.Writer
	// Commit puts what was written at the key.
	Commit(ctx context.Context) error
	// Abort discards what was written. It does nothing after Commit, and may
	// be called more than once; it uses its own short timeout, since the
	// writer's context has often been cancelled by then.
	Abort()
}

// File is a file being read. Seeking is cheap; reading after a seek may
// start another request.
type File interface {
	io.ReadSeekCloser
	Size() int64
	ModTime() time.Time
}

// ValidKey accepts only relative keys that cannot leave the store's root.
func ValidKey(key string) bool {
	return filepath.IsLocal(key) && !strings.Contains(key, "\\")
}

// abortTimeout bounds discarding an unfinished file.
const abortTimeout = 10 * time.Second
