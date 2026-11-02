package query

import "slices"

// maxTotals is the most totals one query asks for; each is another query.
// A pivot table with subtotals asks for every pairing of its row levels with
// its column levels, (rows+1)×(columns+1)−1 of them: 16 is room for three
// dimensions down the side and three across (15), or seven down one side.
const maxTotals = 16

func (q *Query) checkTotals() error {
	if len(q.Totals) == 0 {
		return nil
	}
	if q.Mode == ModeDetail || len(q.Measures) == 0 {
		return bad("invalid_totals", nil, "totals are for aggregate queries with measures")
	}
	if len(q.Totals) > maxTotals {
		return bad("invalid_totals", nil, "a query asks for at most %d totals", maxTotals)
	}
	names := make([]string, len(q.Dimensions))
	for i, d := range q.Dimensions {
		names[i] = d.Name()
	}
	for _, keep := range q.Totals {
		// Keeping every dimension would only ask the query again.
		if len(keep) >= len(names) {
			return bad("invalid_totals", nil, "a total groups by fewer dimensions than the query")
		}
		for i, name := range keep {
			if !slices.Contains(names, name) {
				return bad("invalid_totals", []string{"column", name}, "a total refers to %q, which is not a dimension of the query", name)
			}
			if slices.Contains(keep[:i], name) {
				return bad("invalid_totals", []string{"column", name}, "a total lists %q twice", name)
			}
		}
	}
	return nil
}

// TotalQuery is the query for one of q's totals: the same question grouped by
// only the dimensions it keeps. It covers every row the query reads, however
// many rows the query itself returns.
func (q *Query) TotalQuery(keep []string) Query {
	out := *q
	out.Dimensions = nil
	for _, d := range q.Dimensions {
		if slices.Contains(keep, d.Name()) {
			out.Dimensions = append(out.Dimensions, d)
		}
	}
	out.Sort = slices.DeleteFunc(slices.Clone(q.Sort), func(s Sort) bool {
		return !slices.Contains(keep, s.By) && !slices.ContainsFunc(q.Measures, func(m Measure) bool { return m.Name() == s.By })
	})
	out.Limit, out.Offset, out.Totals = nil, 0, nil
	out.PruneCompute()
	return out
}

// PruneTotals fits the totals to dimensions the query no longer has: a
// dimension that is gone is dropped from each total, and a total that now
// groups by every dimension left, or by the same ones as another, goes.
func (q *Query) PruneTotals() {
	names := make([]string, len(q.Dimensions))
	for i, d := range q.Dimensions {
		names[i] = d.Name()
	}
	var out [][]string
	for _, keep := range q.Totals {
		kept := slices.DeleteFunc(slices.Clone(keep), func(name string) bool { return !slices.Contains(names, name) })
		same := func(other []string) bool {
			return len(other) == len(kept) && !slices.ContainsFunc(other, func(name string) bool { return !slices.Contains(kept, name) })
		}
		if len(kept) < len(names) && !slices.ContainsFunc(out, same) {
			out = append(out, kept)
		}
	}
	q.Totals = out
}
