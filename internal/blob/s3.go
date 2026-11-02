package blob

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type S3Config struct {
	// Endpoint is the address of an S3-compatible store; empty for AWS S3.
	Endpoint string
	Region   string
	Bucket   string
	// Prefix goes before every key, so that installations can share a bucket.
	Prefix string
	// PathStyle addresses buckets as endpoint/bucket rather than as
	// bucket.endpoint, which self-hosted stores usually need.
	PathStyle bool
	// AccessKeyID and SecretAccessKey sign requests. Without them the AWS
	// SDK's default credentials apply: AWS_* variables, ~/.aws and IAM roles.
	AccessKeyID, SecretAccessKey string
}

// S3 keeps files as objects in a bucket. Writing buffers a part in memory at
// a time: a file of one part goes up in a single request, a larger one as a
// multipart upload that appears only once completed.
type S3 struct {
	client *s3.Client
	bucket string
	root   string
	// PartSize is how much is buffered before it is uploaded as a part,
	// unless a file of the size given to Create needs larger parts.
	PartSize int64
}

const DefaultPartSize = 8 << 20

// S3 allows at most this many parts, each but the last at least 5 MB.
const maxParts = 10_000

// partSize is the size of parts that fits a file of up to maxSize into S3's
// limit on the number of parts.
func (s *S3) partSize(maxSize int64) int {
	return int(max(s.PartSize, (maxSize+maxParts-1)/maxParts))
}

// OpenS3 keeps files below dir in cfg's bucket, after checking that the
// bucket can be reached with the credentials given.
func OpenS3(ctx context.Context, cfg S3Config, dir string) (*S3, error) {
	opts := []func(*config.LoadOptions) error{config.WithRegion(cfg.Region)}
	if cfg.AccessKeyID != "" || cfg.SecretAccessKey != "" {
		opts = append(opts, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")))
	}
	awsConfig, err := config.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(awsConfig, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
		o.UsePathStyle = cfg.PathStyle
		// Some S3-compatible stores reject the checksums the SDK otherwise
		// adds to every upload. Requests are still signed with their content.
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	root := strings.Trim(cfg.Prefix, "/")
	if root != "" {
		root += "/"
	}
	s := &S3{client: client, bucket: cfg.Bucket, root: root + dir, PartSize: DefaultPartSize}
	if _, err = client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &s.bucket}); err != nil {
		var response *awshttp.ResponseError
		if errors.As(err, &response) {
			switch response.HTTPStatusCode() {
			case http.StatusNotFound:
				return nil, fmt.Errorf("bucket %q does not exist: %w", cfg.Bucket, err)
			case http.StatusUnauthorized, http.StatusForbidden:
				return nil, fmt.Errorf("bucket %q refused access; check the access key and its permissions: %w", cfg.Bucket, err)
			}
		}
		return nil, fmt.Errorf("bucket %q cannot be reached: %w", cfg.Bucket, err)
	}
	return s, nil
}

func isNotFound(err error) bool {
	var noKey *types.NoSuchKey
	var notFound *types.NotFound
	var response *awshttp.ResponseError
	return errors.As(err, &noKey) || errors.As(err, &notFound) || errors.As(err, &response) && response.HTTPStatusCode() == http.StatusNotFound
}

func (s *S3) Create(ctx context.Context, key string, maxSize int64) (Writer, error) {
	if !ValidKey(key) {
		return nil, ErrInvalidKey
	}
	return &s3Writer{s: s, ctx: ctx, key: s.root + key, partSize: s.partSize(maxSize)}, nil
}

type s3Writer struct {
	s        *S3
	ctx      context.Context
	key      string
	partSize int
	buf      []byte
	// uploadID is set once a part has been uploaded.
	uploadID *string
	parts    []types.CompletedPart
	// err is the first failed upload; nothing more is written after it.
	err  error
	done bool
}

func (w *s3Writer) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 && w.err == nil {
		n := min(len(p), w.partSize-len(w.buf))
		w.buf = append(w.buf, p[:n]...)
		p, written = p[n:], written+n
		if len(w.buf) == w.partSize {
			w.err = w.upload(w.ctx)
		}
	}
	return written, w.err
}

// upload sends what is buffered as the next part, starting a multipart
// upload with the first.
func (w *s3Writer) upload(ctx context.Context) error {
	if w.uploadID == nil {
		out, err := w.s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &w.s.bucket, Key: &w.key})
		if err != nil {
			return err
		}
		w.uploadID = out.UploadId
	}
	number := int32(len(w.parts) + 1)
	out, err := w.s.client.UploadPart(ctx, &s3.UploadPartInput{Bucket: &w.s.bucket, Key: &w.key, UploadId: w.uploadID, PartNumber: &number, Body: bytes.NewReader(w.buf)})
	if err != nil {
		return err
	}
	w.parts = append(w.parts, types.CompletedPart{ETag: out.ETag, PartNumber: &number})
	w.buf = w.buf[:0]
	return nil
}

func (w *s3Writer) Commit(ctx context.Context) error {
	if w.err != nil {
		return w.err
	}
	if w.uploadID == nil {
		if _, err := w.s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &w.s.bucket, Key: &w.key, Body: bytes.NewReader(w.buf)}); err != nil {
			return err
		}
	} else {
		if len(w.buf) > 0 {
			if err := w.upload(ctx); err != nil {
				return err
			}
		}
		_, err := w.s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &w.s.bucket, Key: &w.key, UploadId: w.uploadID,
			MultipartUpload: &types.CompletedMultipartUpload{Parts: w.parts}})
		if err != nil {
			return err
		}
	}
	w.done, w.buf = true, nil
	return nil
}

func (w *s3Writer) Abort() {
	if w.done {
		return
	}
	w.done, w.buf = true, nil
	if w.uploadID == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(w.ctx), abortTimeout)
	defer cancel()
	// An upload left behind here is aborted by a later sweep.
	_, _ = w.s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &w.s.bucket, Key: &w.key, UploadId: w.uploadID})
}

// Open starts reading the whole object, which is what a download usually
// wants; a seek elsewhere reads from there with a ranged request instead.
func (s *S3) Open(ctx context.Context, key string) (File, error) {
	if !ValidKey(key) {
		return nil, ErrInvalidKey
	}
	f := &s3File{s: s, ctx: ctx, key: s.root + key}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &f.key})
	if isNotFound(err) {
		return nil, fmt.Errorf("%s: %w", key, fs.ErrNotExist)
	}
	if err != nil {
		return nil, err
	}
	f.body, f.size, f.modified = out.Body, aws.ToInt64(out.ContentLength), aws.ToTime(out.LastModified)
	return f, nil
}

type s3File struct {
	s              *S3
	ctx            context.Context
	key            string
	size           int64
	modified       time.Time
	body           io.ReadCloser
	bodyAt, offset int64 // where body reads from next, and where reading is
}

func (f *s3File) Size() int64        { return f.size }
func (f *s3File) ModTime() time.Time { return f.modified }

func (f *s3File) Read(p []byte) (int, error) {
	if f.offset >= f.size {
		return 0, io.EOF
	}
	if f.body == nil || f.bodyAt != f.offset {
		if f.body != nil {
			_ = f.body.Close()
			f.body = nil
		}
		out, err := f.s.client.GetObject(f.ctx, &s3.GetObjectInput{Bucket: &f.s.bucket, Key: &f.key, Range: aws.String(fmt.Sprintf("bytes=%d-", f.offset))})
		if err != nil {
			return 0, err
		}
		f.body, f.bodyAt = out.Body, f.offset
	}
	n, err := f.body.Read(p)
	f.offset += int64(n)
	f.bodyAt += int64(n)
	if errors.Is(err, io.EOF) && f.offset < f.size {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func (f *s3File) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += f.offset
	case io.SeekEnd:
		offset += f.size
	default:
		return 0, errors.New("invalid whence")
	}
	if offset < 0 {
		return 0, errors.New("negative position")
	}
	f.offset = offset
	return offset, nil
}

func (f *s3File) Close() error {
	if f.body == nil {
		return nil
	}
	err := f.body.Close()
	f.body = nil
	return err
}

func (s *S3) Remove(ctx context.Context, key string) error {
	if !ValidKey(key) {
		return ErrInvalidKey
	}
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: aws.String(s.root + key)})
	if isNotFound(err) {
		return nil
	}
	return err
}

// Sweep lists the objects below prefix, then the multipart uploads that
// were started there and never completed or aborted.
func (s *S3) Sweep(ctx context.Context, prefix string, cutoff time.Time, keep func(key string) bool) error {
	if prefix != "" && !ValidKey(prefix) {
		return ErrInvalidKey
	}
	// Like a directory: org_1 must not take in org_10's objects.
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	full := s.root + prefix
	objects := s3.NewListObjectsV2Paginator(s.client, &s3.ListObjectsV2Input{Bucket: &s.bucket, Prefix: &full})
	for objects.HasMorePages() {
		page, err := objects.NextPage(ctx)
		if err != nil {
			return err
		}
		for _, o := range page.Contents {
			if !aws.ToTime(o.LastModified).Before(cutoff) || keep(strings.TrimPrefix(aws.ToString(o.Key), s.root)) {
				continue
			}
			if _, err = s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: o.Key}); err != nil && !isNotFound(err) {
				return err
			}
		}
	}
	uploads := s3.NewListMultipartUploadsPaginator(s.client, &s3.ListMultipartUploadsInput{Bucket: &s.bucket, Prefix: &full})
	for uploads.HasMorePages() {
		page, err := uploads.NextPage(ctx)
		if err != nil {
			return err
		}
		for _, u := range page.Uploads {
			if !aws.ToTime(u.Initiated).Before(cutoff) || keep(strings.TrimPrefix(aws.ToString(u.Key), s.root)) {
				continue
			}
			_, err = s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{Bucket: &s.bucket, Key: u.Key, UploadId: u.UploadId})
			var gone *types.NoSuchUpload
			if err != nil && !errors.As(err, &gone) && !isNotFound(err) {
				return err
			}
		}
	}
	return nil
}
