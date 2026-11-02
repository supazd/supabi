package qcache

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"time"

	"github.com/supazd/supabi/internal/datasource"
)

// Entries leave the process in a binary form that keeps the types results are
// normalised to (datasource.Result): JSON would turn integers beyond 2^53
// into floats.
const (
	encodingMagic   = 'Q'
	encodingVersion = 1
	flagCompressed  = 1
	// compressAbove is the encoded size from which entries are compressed.
	compressAbove = 64 << 10
)

const (
	tagNil byte = iota
	tagFalse
	tagTrue
	tagInt
	tagFloat
	tagString
)

func encode(e *Entry) ([]byte, error) {
	var body bytes.Buffer
	w := writer{&body}
	w.varint(e.At.UnixNano())
	w.varint(int64(e.Duration))
	w.uvarint(len(e.Result.Columns))
	for _, col := range e.Result.Columns {
		w.string(col.Name)
		w.string(string(col.Type))
		w.string(col.DBType)
	}
	w.uvarint(len(e.Result.Rows))
	for _, row := range e.Result.Rows {
		w.uvarint(len(row))
		for _, v := range row {
			switch v := v.(type) {
			case nil:
				body.WriteByte(tagNil)
			case bool:
				if v {
					body.WriteByte(tagTrue)
				} else {
					body.WriteByte(tagFalse)
				}
			case int64:
				body.WriteByte(tagInt)
				w.varint(v)
			case float64:
				body.WriteByte(tagFloat)
				var b [8]byte
				binary.LittleEndian.PutUint64(b[:], math.Float64bits(v))
				body.Write(b[:])
			case string:
				body.WriteByte(tagString)
				w.string(v)
			default:
				return nil, fmt.Errorf("%w: a value of type %T", errUnkeepable, v)
			}
		}
	}

	out := bytes.NewBuffer(make([]byte, 0, body.Len()/2+3))
	out.WriteByte(encodingMagic)
	out.WriteByte(encodingVersion)
	if body.Len() <= compressAbove {
		out.WriteByte(0)
		out.Write(body.Bytes())
		return out.Bytes(), nil
	}
	out.WriteByte(flagCompressed)
	zw, err := flate.NewWriter(out, flate.BestSpeed)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(body.Bytes()); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

var (
	errCorrupt = errors.New("qcache: a kept entry cannot be read")
	// errUnkeepable is a result that cannot be written down; it is simply not kept.
	errUnkeepable = errors.New("qcache: the result cannot be kept")
)

func decode(b []byte) (*Entry, error) {
	if len(b) < 3 || b[0] != encodingMagic || b[1] != encodingVersion {
		return nil, errCorrupt
	}
	var in io.Reader = bytes.NewReader(b[3:])
	if b[2]&flagCompressed != 0 {
		in = flate.NewReader(in)
	}
	body, err := io.ReadAll(in)
	if err != nil {
		return nil, errCorrupt
	}
	r := reader{b: body}
	e := &Entry{Result: &datasource.Result{}}
	e.At = time.Unix(0, r.varint())
	e.Duration = time.Duration(r.varint())
	e.Result.Columns = make([]datasource.Column, r.count())
	for i := range e.Result.Columns {
		e.Result.Columns[i] = datasource.Column{Name: r.string(), Type: datasource.Type(r.string()), DBType: r.string()}
	}
	e.Result.Rows = make([][]any, r.count())
	for i := range e.Result.Rows {
		row := make([]any, r.count())
		for j := range row {
			switch r.byte() {
			case tagNil:
			case tagFalse:
				row[j] = false
			case tagTrue:
				row[j] = true
			case tagInt:
				row[j] = r.varint()
			case tagFloat:
				row[j] = math.Float64frombits(binary.LittleEndian.Uint64(r.take(8)))
			case tagString:
				row[j] = r.string()
			default:
				r.err = errCorrupt
			}
		}
		e.Result.Rows[i] = row
	}
	if r.err != nil || r.pos != len(r.b) {
		return nil, errCorrupt
	}
	return e, nil
}

type writer struct{ *bytes.Buffer }

func (w writer) varint(v int64) {
	var b [binary.MaxVarintLen64]byte
	w.Write(b[:binary.PutVarint(b[:], v)])
}

func (w writer) uvarint(n int) {
	var b [binary.MaxVarintLen64]byte
	w.Write(b[:binary.PutUvarint(b[:], uint64(n))])
}

func (w writer) string(s string) {
	w.uvarint(len(s))
	w.WriteString(s)
}

// reader stops at the first problem and remembers it; every read after that
// returns zero values.
type reader struct {
	b   []byte
	pos int
	err error
}

func (r *reader) take(n int) []byte {
	if r.err != nil || n < 0 || len(r.b)-r.pos < n {
		r.err = errCorrupt
		return make([]byte, max(n, 0))
	}
	out := r.b[r.pos : r.pos+n]
	r.pos += n
	return out
}

func (r *reader) byte() byte { return r.take(1)[0] }

func (r *reader) varint() int64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Varint(r.b[r.pos:])
	if n <= 0 {
		r.err = errCorrupt
		return 0
	}
	r.pos += n
	return v
}

// count reads a length, refusing one longer than what is left to read.
func (r *reader) count() int {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.b[r.pos:])
	if n <= 0 || v > uint64(len(r.b)-r.pos-n) {
		r.err = errCorrupt
		return 0
	}
	r.pos += n
	return int(v)
}

func (r *reader) string() string { return string(r.take(r.count())) }
