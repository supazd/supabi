// Package qcache keeps the results of compiled statements for a while, so
// that the same question asked again does not reach the database again. See
// .agents/design/query-ir.md §6.
//
// It sits between the query compiler and the data source: a key is made from
// the SQL and the bound values, after data permissions were written into
// them, so two people share a result only when they would have run exactly
// the same statement.
package qcache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"math"
	"strconv"
	"time"
)

// keyVersion changes whenever what is cached changes shape, which retires
// every earlier entry at once.
const keyVersion = "1"

// Key identifies a statement on one data source as it was configured: version
// is whatever changes when the data source's settings do.
func Key(datasourceID, version, sql string, args []any) string {
	h := sha256.New()
	for _, part := range []string{keyVersion, datasourceID, version, sql} {
		writePart(h, part)
	}
	writeLength(h, len(args))
	for _, arg := range args {
		kind, value := typed(arg)
		writePart(h, kind)
		writePart(h, value)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// typed writes a bound value with its type, so that 1 and "1" differ.
func typed(v any) (kind, value string) {
	switch v := v.(type) {
	case nil:
		return "nil", ""
	case string:
		return "string", v
	case bool:
		return "bool", strconv.FormatBool(v)
	case int:
		return "int", strconv.Itoa(v)
	case int64:
		return "int64", strconv.FormatInt(v, 10)
	case float64:
		return "float64", strconv.FormatUint(math.Float64bits(v), 16)
	case time.Time:
		// Not String: that carries the monotonic clock reading of time.Now.
		return "time", v.Format(time.RFC3339Nano) + " " + v.Location().String()
	case []byte:
		return "bytes", string(v)
	}
	raw, err := json.Marshal(v)
	if err != nil {
		raw = fmt.Appendf(nil, "%#v", v)
	}
	return fmt.Sprintf("%T", v), string(raw)
}

func writePart(h hash.Hash, s string) {
	writeLength(h, len(s))
	h.Write([]byte(s))
}

func writeLength(h hash.Hash, n int) {
	var b [binary.MaxVarintLen64]byte
	h.Write(b[:binary.PutUvarint(b[:], uint64(n))])
}
