package query

import (
	"strconv"
	"strings"

	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
)

// candidateValues projects source rows only after their original chart group
// passes HAVING. Grouping by the option field itself would change the aggregate
// and either lose valid choices or admit values from rejected groups.
func (c *compiler) candidateValues(groups, from string, rowConditions []string) (*Compiled, error) {
	field, value, err := c.dimensionValue(Dimension{Field: c.q.Candidates.Field})
	if err != nil {
		return nil, err
	}
	const groupAlias = "filter_groups"
	join := make([]string, 0, len(c.q.Dimensions))
	for i, dim := range c.q.Dimensions {
		_, left, err := c.dimensionValue(dim)
		if err != nil {
			return nil, err
		}
		right := groupAlias + "." + c.d.QuoteIdent(c.columns[i].Name)
		join = append(join, c.d.NullSafeEqual(left, right))
	}
	joined := "\nCROSS JOIN (\n" + groups + "\n) AS " + groupAlias
	if len(join) > 0 {
		joined = "\nINNER JOIN (\n" + groups + "\n) AS " + groupAlias + " ON " + strings.Join(join, " AND ")
	}
	where := append([]string(nil), rowConditions...)
	where = append(where, value+" IS NOT NULL")
	if c.q.Candidates.Search != "" && field.Type == datasource.String {
		where = append(where, c.d.Match(value, dialect.Contains, c.q.Candidates.Search, c.args.add))
	}
	limit, err := c.limit()
	if err != nil {
		return nil, err
	}
	if c.failed != nil {
		return nil, c.failed
	}
	statement := "SELECT " + value + " AS " + c.d.QuoteIdent(field.Key) +
		"\nFROM " + from + joined +
		"\nWHERE " + strings.Join(where, " AND ") + "\nGROUP BY 1\nORDER BY 1\nLIMIT " + strconv.Itoa(limit+1)
	// Reusing source/condition markers is deliberate: finalize repeats argument
	// values for positional-placeholder dialects and numbers them for PostgreSQL.
	sql, ordered := c.args.finalize(statement, c.d)
	return &Compiled{
		SQL: sql, Args: ordered, Limit: limit,
		Columns: []OutputColumn{{Name: field.Key, Type: field.Type, Role: "dimension", Label: field.Label, Format: field.Format}},
	}, nil
}
