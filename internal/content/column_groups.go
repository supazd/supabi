package content

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/query"
)

// maxColumnGroupDepth is how deep a table's column groups nest; its header
// has one row more, for the columns' own names.
const maxColumnGroupDepth = 3

// maxColumnGroupLabel is the longest a group's name may be, in characters, as
// for axis titles and page names.
const maxColumnGroupLabel = 50

// ColumnGroup is a header over adjacent columns of a table. Its items are
// output columns or smaller groups, in the order the columns come.
type ColumnGroup struct {
	Label   string            `json:"label"`
	Columns []ColumnGroupItem `json:"columns"`
}

// ColumnGroupItem is an output column, written as its alias, or a group.
type ColumnGroupItem struct {
	Column string
	Group  *ColumnGroup
}

func (i ColumnGroupItem) MarshalJSON() ([]byte, error) {
	if i.Group != nil {
		return json.Marshal(i.Group)
	}
	return json.Marshal(i.Column)
}

func (i *ColumnGroupItem) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		*i = ColumnGroupItem{}
		return json.Unmarshal(data, &i.Column)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var group ColumnGroup
	if err := decoder.Decode(&group); err != nil {
		return err
	}
	*i = ColumnGroupItem{Group: &group}
	return nil
}

// leaves are the columns under the group, in order.
func (g ColumnGroup) leaves() []string {
	var names []string
	for _, item := range g.Columns {
		if item.Group != nil {
			names = append(names, item.Group.leaves()...)
		} else {
			names = append(names, item.Column)
		}
	}
	return names
}

// validateColumnGroups checks that the groups name output columns, each at
// most once, in the order the query returns them, and that each group covers
// columns next to each other, hidden ones counted, so groups nest and never
// cross whichever columns are shown.
func (v Viz) validateColumnGroups(columns []query.OutputColumn) error {
	at := map[string]int{}
	for i, c := range columns {
		at[c.Name] = i
	}
	var all []ColumnGroup
	var walk func(groups []ColumnGroup, depth int) error
	walk = func(groups []ColumnGroup, depth int) error {
		for _, group := range groups {
			if depth > maxColumnGroupDepth {
				return bad("viz_invalid_column_groups", nil, "column groups nest at most %d deep", maxColumnGroupDepth)
			}
			if strings.TrimSpace(group.Label) == "" {
				return bad("viz_invalid_column_groups", nil, "a column group needs a label")
			}
			if utf8.RuneCountInString(group.Label) > maxColumnGroupLabel {
				return bad("viz_invalid_column_groups", nil, "column group names are at most %d characters", maxColumnGroupLabel)
			}
			if len(group.Columns) == 0 {
				return bad("viz_invalid_column_groups", nil, "column group %q has no columns", group.Label)
			}
			all = append(all, group)
			var inner []ColumnGroup
			for _, item := range group.Columns {
				if item.Group != nil {
					inner = append(inner, *item.Group)
				}
			}
			if err := walk(inner, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(v.ColumnGroups, 1); err != nil {
		return err
	}

	var written []string
	for _, group := range v.ColumnGroups {
		written = append(written, group.leaves()...)
	}
	for i, name := range written {
		if _, exists := at[name]; !exists {
			return bad("viz_unknown_column", []string{"column", name, "property", "columnGroups"}, "columnGroups refers to %q, which the query does not return", name)
		}
		if slices.Contains(written[:i], name) {
			return bad("viz_duplicate_column", []string{"column", name}, "%q is listed twice", name)
		}
		if i > 0 && at[name] < at[written[i-1]] {
			return bad("viz_invalid_column_groups", nil, "columnGroups lists %q before %q, which the query returns first", written[i-1], name)
		}
	}
	for _, group := range all {
		leaves := group.leaves()
		if at[leaves[len(leaves)-1]]-at[leaves[0]]+1 != len(leaves) {
			return bad("viz_invalid_column_groups", nil, "the columns of group %q are not next to each other", group.Label)
		}
	}
	return nil
}
