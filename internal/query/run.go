package query

import (
	"context"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// Column is one column of a Result. See .agents/design/query-ir.md §4.
type Column struct {
	Name   string          `json:"name"`
	Type   datasource.Type `json:"type"`
	Role   string          `json:"role"`
	Label  string          `json:"label,omitempty"`
	Format *dataset.Format `json:"format,omitempty"`
	Grain  dialect.Grain   `json:"grain,omitempty"`
	// Agg is how a measure column was aggregated; a metric has none.
	Agg        string      `json:"agg,omitempty"`
	Compute    string      `json:"compute,omitempty"`
	Comparison *Comparison `json:"comparison,omitempty"`
}

type Meta struct {
	// Truncated is set when more rows matched than the limit allowed.
	Truncated  bool  `json:"truncated"`
	DurationMs int64 `json:"durationMs"`
}

type Result struct {
	Columns []Column `json:"columns"`
	Rows    [][]any  `json:"rows"`
	Meta    Meta     `json:"meta"`
}

// Run executes a compiled query.
func Run(ctx context.Context, conn datasource.Conn, c *Compiled) (*Result, error) {
	started := time.Now()
	raw, err := conn.Query(ctx, c.SQL, c.Args)
	if err != nil {
		return nil, err
	}
	result := Shape(c, raw)
	result.Meta.DurationMs = time.Since(started).Milliseconds()
	return result, nil
}

// Shape turns what the database returned for a compiled query into its
// result: labels and formats come from the query as compiled now, so a
// result kept from before shows the dataset as it is. raw is not changed,
// since a kept result is shared.
func Shape(c *Compiled, raw *datasource.Result) *Result {
	result := &Result{Columns: make([]Column, len(c.Columns)), Rows: raw.Rows}
	for i, col := range c.Columns {
		result.Columns[i] = Column{Name: col.Name, Type: col.Type, Role: col.Role, Label: col.Label, Format: col.Format, Grain: col.Grain, Agg: string(col.Agg), Compute: col.Compute, Comparison: col.Comparison}
		// What the database actually returned is more accurate than what we
		// inferred, notably for measures written as expressions.
		if col.Role == "measure" && i < len(raw.Columns) {
			result.Columns[i].Type = raw.Columns[i].Type
		}
	}
	if len(result.Rows) > c.Limit {
		result.Rows = result.Rows[:c.Limit:c.Limit]
		result.Meta.Truncated = true
	}
	return result
}
