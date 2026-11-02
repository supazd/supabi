// Package blobtest gives tests a store of their own: a temporary directory,
// or a prefix of their own in the S3 bucket that SUPABI_TEST_S3_* names.
package blobtest

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/blob"
	"github.com/supazd/supabi/internal/id"
)

// Each runs a test against every store there is to test: S3 only when
// SUPABI_TEST_S3_BUCKET names a bucket.
func Each(t *testing.T, test func(t *testing.T, files blob.Store)) {
	t.Run("local", func(t *testing.T) { test(t, blob.NewLocal(t.TempDir())) })
	t.Run("s3", func(t *testing.T) { test(t, S3(t)) })
}

// S3 skips the test unless SUPABI_TEST_S3_BUCKET is set. A store at another
// address than AWS's, SUPABI_TEST_S3_ENDPOINT, is addressed by path. Parts
// are as small as S3 allows, so that tests reach multipart uploads quickly.
// What the test leaves is deleted after it.
func S3(t *testing.T) *blob.S3 {
	t.Helper()
	bucket := os.Getenv("SUPABI_TEST_S3_BUCKET")
	if bucket == "" {
		t.Skip("SUPABI_TEST_S3_BUCKET is not set")
	}
	cfg := blob.S3Config{
		Endpoint: os.Getenv("SUPABI_TEST_S3_ENDPOINT"), Region: os.Getenv("SUPABI_TEST_S3_REGION"), Bucket: bucket,
		Prefix:      "supabi-test/" + id.New("t"),
		AccessKeyID: os.Getenv("SUPABI_TEST_S3_ACCESS_KEY_ID"), SecretAccessKey: os.Getenv("SUPABI_TEST_S3_SECRET_ACCESS_KEY"),
	}
	cfg.PathStyle = cfg.Endpoint != ""
	if cfg.Region == "" {
		cfg.Region = "us-east-1"
	}
	files, err := blob.OpenS3(context.Background(), cfg, "exports/")
	if err != nil {
		t.Fatal(err)
	}
	files.PartSize = 5 << 20
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := files.Sweep(ctx, "", time.Now().Add(time.Hour), func(string) bool { return false }); err != nil {
			t.Errorf("clean up the test's objects: %v", err)
		}
	})
	return files
}

// Keys lists the keys below prefix, of files and of unfinished writes alike,
// without removing anything.
func Keys(t *testing.T, files blob.Store, prefix string) []string {
	t.Helper()
	var keys []string
	if err := files.Sweep(context.Background(), prefix, time.Now().Add(time.Hour), func(key string) bool {
		keys = append(keys, key)
		return true
	}); err != nil {
		t.Fatal(err)
	}
	slices.Sort(keys)
	return keys
}
