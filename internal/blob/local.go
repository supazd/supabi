package blob

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Local keeps files below a directory. Files are written as .part files
// next to their final name and renamed into place once synced.
type Local struct {
	Root string
}

func NewLocal(root string) *Local { return &Local{Root: root} }

func (l *Local) path(key string) (string, error) {
	if !ValidKey(key) {
		return "", ErrInvalidKey
	}
	return filepath.Join(l.Root, filepath.FromSlash(key)), nil
}

func (l *Local) Create(_ context.Context, key string, _ int64) (Writer, error) {
	path, err := l.path(key)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path+".part", os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	return &localWriter{File: f, path: path}, nil
}

type localWriter struct {
	*os.File
	path string
	done bool
}

func (w *localWriter) Commit(context.Context) error {
	if err := w.Sync(); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	if err := os.Rename(w.path+".part", w.path); err != nil {
		return err
	}
	w.done = true
	return nil
}

func (w *localWriter) Abort() {
	if w.done {
		return
	}
	w.done = true
	_ = w.Close()
	_ = os.Remove(w.path + ".part")
}

func (l *Local) Open(_ context.Context, key string) (File, error) {
	path, err := l.path(key)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return localFile{File: f, info: info}, nil
}

type localFile struct {
	*os.File
	info os.FileInfo
}

func (f localFile) Size() int64        { return f.info.Size() }
func (f localFile) ModTime() time.Time { return f.info.ModTime() }

func (l *Local) Remove(_ context.Context, key string) error {
	path, err := l.path(key)
	if err != nil {
		return err
	}
	err = os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// removeFile is replaced in tests to act as a concurrent sweep would.
var removeFile = os.Remove

// Sweep walks the directory of prefix. A .part file is an unfinished write,
// kept or removed by the key it has, .part included. Empty directories are
// removed once they are older than cutoff too.
func (l *Local) Sweep(ctx context.Context, prefix string, cutoff time.Time, keep func(key string) bool) error {
	root := l.Root
	if prefix != "" {
		var err error
		if root, err = l.path(prefix); err != nil {
			return err
		}
	}
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		info, err := d.Info()
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if !info.ModTime().Before(cutoff) {
			return nil
		}
		key, err := filepath.Rel(l.Root, path)
		if err != nil {
			return err
		}
		if keep(filepath.ToSlash(key)) {
			return nil
		}
		if err = removeFile(path); errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	})
	// Remove empty directories only; a concurrent writer makes Remove fail
	// harmlessly, and no recursive deletion can remove its file.
	for i := len(dirs) - 1; i >= 0; i-- {
		if dirs[i] == l.Root {
			continue
		}
		if info, err := os.Stat(dirs[i]); err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(dirs[i])
		}
	}
	return err
}
