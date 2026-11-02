package query

import (
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// args collects bound values while SQL is assembled out of order. Each value
// is represented in the text by a marker; finalize then numbers the
// placeholders in the order they appear, which is what positional dialects
// ("?") require and what lets an expression be repeated (SELECT and HAVING).
type args struct {
	values []any
}

const markerByte = "\x00"

func (a *args) add(v any) string {
	a.values = append(a.values, v)
	return markerByte + strconv.Itoa(len(a.values)-1) + markerByte
}

// bind adds a value as an argument. Text that stands for a value of another
// type, such as a date, is marked as that type for databases that would not
// compare text with it.
func (c *compiler) bind(v any, t datasource.Type) string {
	marker := c.args.add(v)
	if _, text := v.(string); text && t != datasource.String {
		return c.d.TextAs(marker, string(t))
	}
	return marker
}

func (a *args) finalize(sql string, d dialect.Dialect) (string, []any) {
	out, ordered, _ := a.finalizeAt(sql, d, nil)
	return out, ordered
}

// finalizeAt is finalize that also follows positions: offsets are places in
// sql outside any marker, in ascending order, and it returns where each one
// ends up in the result.
func (a *args) finalizeAt(sql string, d dialect.Dialect, offsets []int) (string, []any, []int) {
	var out strings.Builder
	var ordered []any
	moved := make([]int, 0, len(offsets))
	consumed := 0 // how much of the original has been read
	for {
		start := strings.Index(sql, markerByte)
		literal := len(sql)
		if start >= 0 {
			literal = start
		}
		for len(offsets) > 0 && offsets[0] <= consumed+literal {
			moved = append(moved, out.Len()+offsets[0]-consumed)
			offsets = offsets[1:]
		}
		out.WriteString(sql[:literal])
		if start < 0 {
			break
		}
		end := start + 1 + strings.Index(sql[start+1:], markerByte)
		index, _ := strconv.Atoi(sql[start+1 : end])
		ordered = append(ordered, a.values[index])
		out.WriteString(d.Placeholder(len(ordered)))
		consumed += end + 1
		sql = sql[end+1:]
	}
	return out.String(), ordered, moved
}
