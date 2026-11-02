package blob_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"path"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/blob/blobtest"
)

// write puts content at key, committing it unless asked not to.
func write(t *testing.T, files blob.Store, key string, content []byte, commit bool) blob.Writer {
	t.Helper()
	ctx := context.Background()
	w, err := files.Create(ctx, key, int64(len(content)))
	if err != nil {
		t.Fatal(err)
	}
	// In pieces, as an export's writer would.
	for chunk := range slices.Chunk(content, 64<<10) {
		if _, err := w.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if commit {
		if err := w.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	return w
}

func read(t *testing.T, files blob.Store, key string) ([]byte, error) {
	t.Helper()
	f, err := files.Open(context.Background(), key)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

func missing(t *testing.T, files blob.Store, key string) {
	t.Helper()
	if _, err := read(t, files, key); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("%s: got %v, want it missing", key, err)
	}
}

// pattern is content in which every offset reads differently.
func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i % 251)
	}
	return b
}

func TestWriteThenRead(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		// Small files go up whole; the large one in parts of 5 MB on S3.
		for name, content := range map[string][]byte{"empty": nil, "small": []byte("hello world"), "large": pattern(11<<20 + 3)} {
			t.Run(name, func(t *testing.T) {
				key := "org/ws/exp/run/" + name + ".csv"
				w := write(t, files, key, content, false)
				missing(t, files, key)
				if err := w.Commit(context.Background()); err != nil {
					t.Fatal(err)
				}
				w.Abort() // does nothing once committed
				got, err := read(t, files, key)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(got, content) {
					t.Fatalf("read %d bytes back, want %d", len(got), len(content))
				}
				f, err := files.Open(context.Background(), key)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
				if f.Size() != int64(len(content)) || time.Since(f.ModTime()) > time.Minute {
					t.Fatalf("size %d, modified %v", f.Size(), f.ModTime())
				}
				if len(content) < 10 {
					return
				}
				// As a download resuming near the end, after asking the size.
				at := int64(len(content) - 7)
				if end, err := f.Seek(0, io.SeekEnd); err != nil || end != int64(len(content)) {
					t.Fatalf("seek to the end: %d, %v", end, err)
				}
				if _, err := f.Seek(at, io.SeekStart); err != nil {
					t.Fatal(err)
				}
				tail, err := io.ReadAll(f)
				if err != nil || !bytes.Equal(tail, content[at:]) {
					t.Fatalf("read from %d: %q, %v", at, tail, err)
				}
			})
		}
	})
}

func TestAbortLeavesNothing(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		for name, size := range map[string]int{"small": 100, "multipart": 6 << 20} {
			key := "org/ws/exp/run/" + name + ".csv"
			w := write(t, files, key, pattern(size), false)
			w.Abort()
			w.Abort()
			missing(t, files, key)
		}
		if keys := blobtest.Keys(t, files, ""); len(keys) != 0 {
			t.Fatalf("left behind: %v", keys)
		}
	})
}

func TestRemove(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		ctx := context.Background()
		key := "org/ws/exp/run/result.csv"
		write(t, files, key, []byte("x"), true)
		for range 2 {
			if err := files.Remove(ctx, key); err != nil {
				t.Fatal(err)
			}
			missing(t, files, key)
		}
		for _, bad := range []string{"", "../outside", "/absolute", `org\ws`, "org/../../outside"} {
			if _, err := files.Create(ctx, bad, 1); !errors.Is(err, blob.ErrInvalidKey) {
				t.Errorf("create %q: %v", bad, err)
			}
			if _, err := files.Open(ctx, bad); !errors.Is(err, blob.ErrInvalidKey) {
				t.Errorf("open %q: %v", bad, err)
			}
			if err := files.Remove(ctx, bad); !errors.Is(err, blob.ErrInvalidKey) {
				t.Errorf("remove %q: %v", bad, err)
			}
		}
	})
}

// A sweep removes old files and unfinished writes that are not kept, and
// leaves alone what is below another prefix, even one that starts the same.
func TestSweep(t *testing.T) {
	blobtest.Each(t, func(t *testing.T, files blob.Store) {
		ctx := context.Background()
		published, live := "org/ws/exp_1/run_1/result.csv", "org/ws/exp_2/run_2/result.csv"
		orphan, dead := "org/ws/exp_3/run_3/result.csv", "org/ws/exp_4/run_4/result.csv"
		other := "org1/ws/exp_5/run_5/result.csv"
		for _, key := range []string{published, orphan, other} {
			write(t, files, key, []byte("x"), true)
		}
		// Unfinished, and on S3 already a multipart upload.
		liveWriter := write(t, files, live, pattern(6<<20), false)
		deadWriter := write(t, files, dead, pattern(6<<20), false)
		keep := func(key string) bool { return key == published || path.Dir(key) == path.Dir(live) }

		if err := files.Sweep(ctx, "org", time.Now().Add(-time.Hour), keep); err != nil {
			t.Fatal(err)
		}
		if keys := blobtest.Keys(t, files, "org"); len(keys) != 4 {
			t.Fatalf("a sweep removed recent files: %v", keys)
		}
		var group sync.WaitGroup
		errs := make([]error, 2)
		for i := range errs {
			group.Go(func() { errs[i] = files.Sweep(ctx, "org/", time.Now().Add(time.Minute), keep) })
		}
		group.Wait()
		if err := errors.Join(errs...); err != nil {
			t.Fatalf("concurrent sweeps: %v", err)
		}

		if _, err := read(t, files, published); err != nil {
			t.Fatal(err)
		}
		if _, err := read(t, files, other); err != nil {
			t.Fatalf("another prefix was swept: %v", err)
		}
		missing(t, files, orphan)
		if err := liveWriter.Commit(ctx); err != nil {
			t.Fatalf("a live write was swept: %v", err)
		}
		if err := deadWriter.Commit(ctx); err == nil {
			t.Fatal("an unfinished write survived the sweep")
		}
		deadWriter.Abort()
		missing(t, files, dead)
		if keys := blobtest.Keys(t, files, "org"); !slices.Equal(keys, []string{published, live}) {
			t.Fatalf("after the sweep: %v", keys)
		}
	})
}
