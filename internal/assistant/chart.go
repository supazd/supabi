package assistant

import (
	"cmp"
	"encoding/json"
	"fmt"
	"math/big"
	"slices"
	"strings"

	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// Charts the model draws in an answer. It names the lookups and columns to
// draw and never the figures: those come from the rows the lookups gave it,
// so a chart has the sources its answer's text has. See
// .agents/design/ai-assistant.md 12.10.

const chartName = "draw_chart"

// chartRows is how many rows of series worked out the model is given back.
const chartRows = 200

// chartTypes are the types an answer draws.
var chartTypes = []string{content.Bar, content.HBar, content.Line, content.Area, content.Combo, content.Pie, content.Funnel}

var chartTool = llm.Tool{
	Name: chartName,
	Description: `Draws a chart in the conversation from data this answer looked up with query_chart. Draw when a chart shows more than words: a trend over time, a ranking or comparison of several items, the shares of a whole. Do not draw one or two figures.
Name the lookup by its source number and its columns by the names the result gives them; never write figures. The rows of several lookups are matched on the category column, so one chart can compare lookups, such as two regions looked up apart. A series may instead be worked out row by row from the series before it, such as a growth rate; such a chart is a source of its own, and its figures are given back to cite.
Time goes on a line or area chart; categories on a bar chart, or hbar when the names are long; stages on a funnel. Draw a pie only of a measure that adds up to a whole, such as sales or a count, never of averages, ratios or distinct counts. Series on one value axis must be written alike: put an amount and a percentage on the two axes of a combo chart. Usually one chart an answer is enough, and the text still gives the key figures with their sources.`,
	Parameters: json.RawMessage(`{"type":"object","properties":{` +
		`"type":{"type":"string","enum":["bar","hbar","line","area","combo","pie","funnel"]},` +
		`"title":{"type":"string","description":"What the chart shows, such as East China sales by month."},` +
		`"x":{"type":"string","description":"The dimension column the categories come from, by its name in the result."},` +
		`"split":{"type":"string","description":"A dimension column to split the one series drawn by: a line or group of bars for each of its values. Every lookup used must have it."},` +
		`"series":{"type":"array","description":"What is drawn, in order.","items":{"type":"object","properties":{` +
		`"id":{"type":"string","description":"A short name, such as east, for expressions and the other properties."},` +
		`"name":{"type":"string","description":"Shown in the legend, such as East China."},` +
		`"source":{"type":"integer","description":"The source number of a query_chart result of this answer."},` +
		`"column":{"type":"string","description":"A measure column of that result, by its name."},` +
		`"x":{"type":"string","description":"The category column of that result, when it names it other than x."},` +
		`"expression":{"type":"string","description":"In place of source and column: worked out on each row from the ids of series before it, with + - * / and parentheses, such as (now - last) / last."},` +
		`"draw":{"type":"boolean","description":"False for a series used only in expressions."},` +
		`"format":{"type":"object","description":"How a series worked out is written; one taken from a column is written as the column is.","properties":{` +
		`"style":{"type":"string","enum":["number","percent"],"description":"Percent shows 0.25 as 25%."},` +
		`"decimals":{"type":"integer","minimum":0,"maximum":10},` +
		`"unit":{"type":"string","enum":["auto","K","wan","M","yi","B"]},` +
		`"prefix":{"type":"string"},"suffix":{"type":"string"}}}` +
		`},"required":["id","name"]}},` +
		`"stacked":{"type":"boolean","description":"Bar, hbar and area charts: stack the series."},` +
		`"lines":{"type":"array","items":{"type":"string"},"description":"Combo charts: the series ids drawn as lines; the others are bars."},` +
		`"rightAxis":{"type":"array","items":{"type":"string"},"description":"Combo charts: the series ids read on the right axis."}` +
		`},"required":["type","title","x","series"]}`),
}

// Table is the data a lookup gave the model: the result's columns as the API
// writes them and the rows the model read, which charts are drawn from.
type Table struct {
	Columns []Column
	Rows    [][]any
	// Truncated says the lookup had more rows than the model was given.
	Truncated bool
}

// Column is a column of a lookup's result.
type Column struct {
	Name   string          `json:"name"`
	Type   datasource.Type `json:"type"`
	Role   string          `json:"role"`
	Label  string          `json:"label,omitempty"`
	Format *dataset.Format `json:"format,omitempty"`
	Grain  string          `json:"grain,omitempty"`
}

func (t *Table) column(name string) (int, *Column) {
	for i := range t.Columns {
		if t.Columns[i].Name == name {
			return i, &t.Columns[i]
		}
	}
	return -1, nil
}

// names lists the columns of a role, for the model to choose from: of
// measures, those that are numbers, which alone can be drawn.
func (t *Table) names(role string) string {
	var out []string
	for _, c := range t.Columns {
		if c.Role == role && (role != "measure" || c.Type.Numeric()) {
			out = append(out, c.Name)
		}
	}
	return strings.Join(out, ", ")
}

type chartRequest struct {
	Type      string        `json:"type"`
	Title     string        `json:"title"`
	X         string        `json:"x"`
	Split     string        `json:"split"`
	Series    []chartSeries `json:"series"`
	Stacked   bool          `json:"stacked"`
	Lines     []string      `json:"lines"`
	RightAxis []string      `json:"rightAxis"`
}

type chartSeries struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Source     int             `json:"source"`
	Column     string          `json:"column"`
	X          string          `json:"x"`
	Expression string          `json:"expression"`
	Draw       *bool           `json:"draw"`
	Format     *dataset.Format `json:"format"`
}

func (s chartSeries) drawn() bool { return s.Draw == nil || *s.Draw }

// placed is where a series taken from a column finds its values.
type placed struct {
	table        *Table
	x, split, at int
}

// drawChart builds the chart the model asked for out of the tables of this
// answer's lookups, by their source numbers. A chart that works series out
// also returns their figures, which the answer may cite and calculate with.
func drawChart(arguments string, tables map[int]*Table) (ToolResult, []*big.Rat) {
	var req chartRequest
	dec := json.NewDecoder(strings.NewReader(arguments))
	dec.UseNumber()
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return notDrawn("The arguments are not what draw_chart takes: " + err.Error())
	}
	req.Title = strings.TrimSpace(req.Title)
	switch {
	case !slices.Contains(chartTypes, req.Type):
		return notDrawn(fmt.Sprintf("type %q is not one draw_chart draws: use one of %s.", req.Type, strings.Join(chartTypes, ", ")))
	case req.Title == "":
		return notDrawn("The chart needs a title.")
	case req.X == "":
		return notDrawn("The chart needs x, the column its categories come from.")
	case len(req.Series) == 0:
		return notDrawn("The chart needs at least one series.")
	}

	// Each series is checked in turn: an expression may use only those before it.
	ids := map[string]int{}
	where := make([]placed, len(req.Series))
	var (
		used        []int
		first       *Column
		firstSplit  *Column
		calculation []store.ChartCalculation
	)
	for i, s := range req.Series {
		tokens := tokenize(s.ID)
		switch {
		case len(tokens) != 1 || tokens[0].name != s.ID:
			return notDrawn(fmt.Sprintf("Series id %q is not a name: use letters, digits and _, starting with a letter.", s.ID))
		case ids[s.ID] > 0:
			return notDrawn(fmt.Sprintf("Two series have the id %s.", s.ID))
		case s.ID == req.X || s.ID == req.Split:
			return notDrawn(fmt.Sprintf("Series id %s is the name of a column the chart is drawn along: choose another.", s.ID))
		case strings.TrimSpace(s.Name) == "":
			return notDrawn(fmt.Sprintf("Series %s needs a name, for the legend.", s.ID))
		case (s.Expression == "") == (s.Source == 0 && s.Column == ""):
			return notDrawn(fmt.Sprintf("Series %s needs either a source and a column, or an expression.", s.ID))
		}
		ids[s.ID] = i + 1
		if s.Expression != "" {
			calc, problem := checkExpression(s, req.Series[:i])
			if problem != "" {
				return notDrawn(problem)
			}
			calculation = append(calculation, calc)
			continue
		}
		if s.Format != nil {
			return notDrawn(fmt.Sprintf("Series %s is taken from a column, and is written as the column is: leave out its format.", s.ID))
		}
		table := tables[s.Source]
		if table == nil {
			return notDrawn(fmt.Sprintf("Series %s names source [%d], which is not a query_chart result of this answer: draw from what this answer looked up.", s.ID, s.Source))
		}
		at, col := table.column(s.Column)
		if col == nil || col.Role != "measure" || !col.Type.Numeric() {
			return notDrawn(fmt.Sprintf("Source [%d] has no measure column %q of numbers, for series %s; those it has are: %s.", s.Source, s.Column, s.ID, table.names("measure")))
		}
		xName := cmp.Or(s.X, req.X)
		x, xCol := table.column(xName)
		if xCol == nil || xCol.Role != "dimension" {
			return notDrawn(fmt.Sprintf("Source [%d] has no dimension column %q, for the categories of series %s; its dimensions are: %s.", s.Source, xName, s.ID, table.names("dimension")))
		}
		split := -1
		if req.Split != "" {
			var splitCol *Column
			split, splitCol = table.column(req.Split)
			if splitCol == nil || splitCol.Role != "dimension" {
				return notDrawn(fmt.Sprintf("Source [%d] has no dimension column %q to split by; its dimensions are: %s.", s.Source, req.Split, table.names("dimension")))
			}
			if firstSplit == nil {
				firstSplit = splitCol
			} else if !alike(firstSplit, splitCol) {
				return notDrawn(fmt.Sprintf("The column to split by is %s in one lookup and %s in source [%d]: they cannot be matched.", kind(firstSplit), kind(splitCol), s.Source))
			}
		}
		if first == nil {
			first = xCol
		} else if !alike(first, xCol) {
			return notDrawn(fmt.Sprintf("The categories are %s in one lookup and %s in source [%d]: they cannot be matched. Look the data up alike, or draw them apart.", kind(first), kind(xCol), s.Source))
		}
		where[i] = placed{table: table, x: x, split: split, at: at}
		if !slices.Contains(used, s.Source) {
			used = append(used, s.Source)
		}
	}
	if first == nil {
		return notDrawn("Every series is worked out: at least one must be taken from a lookup.")
	}

	// The rows of every lookup used, matched on their categories.
	type row struct {
		x, split any
		values   []*big.Rat
		cells    []any
	}
	var rows []*row
	byKey := map[string]*row{}
	for i, s := range req.Series {
		p := where[i]
		if p.table == nil {
			continue
		}
		seen := map[string]bool{}
		for _, r := range p.table.Rows {
			x, split := r[p.x], any(nil)
			if p.split >= 0 {
				split = r[p.split]
			}
			key := cellKey(x) + "\x00" + cellKey(split)
			if seen[key] {
				return notDrawn(fmt.Sprintf("Source [%d] has more than one row for %s: it has a dimension more than the chart is drawn along. Split by it, or look the data up without it.", s.Source, place(x, split)))
			}
			seen[key] = true
			out := byKey[key]
			if out == nil {
				out = &row{x: x, split: split, values: make([]*big.Rat, len(req.Series)), cells: make([]any, len(req.Series))}
				byKey[key] = out
				rows = append(rows, out)
			}
			out.cells[i] = r[p.at]
			out.values[i], _ = toNumber(r[p.at])
		}
	}
	if first.Type.Temporal() {
		slices.SortStableFunc(rows, func(a, b *row) int { return strings.Compare(fmt.Sprint(a.x), fmt.Sprint(b.x)) })
	}
	var empty, unworked []string
	for _, r := range rows {
		for i, s := range req.Series {
			if where[i].table != nil && r.cells[i] == nil && s.drawn() {
				empty = append(empty, s.Name+" "+place(r.x, r.split))
			}
			if s.Expression == "" {
				continue
			}
			values := map[string]*big.Rat{}
			for j, earlier := range req.Series[:i] {
				if r.values[j] != nil {
					values[earlier.ID] = r.values[j]
				}
			}
			if v, err := evaluate(s.Expression, values); err == nil {
				r.values[i], r.cells[i] = v, decimalText(v)
			} else if s.drawn() {
				unworked = append(unworked, s.Name+" "+place(r.x, r.split))
			}
		}
	}

	// What is drawn, as a query result with a viz over it.
	columns := []Column{{Name: req.X, Type: first.Type, Role: "dimension", Label: first.Label, Format: first.Format, Grain: first.Grain}}
	if firstSplit != nil {
		columns = append(columns, Column{Name: req.Split, Type: firstSplit.Type, Role: "dimension", Label: firstSplit.Label, Format: firstSplit.Format, Grain: firstSplit.Grain})
	}
	viz := content.Viz{Type: req.Type, X: req.X, Series: req.Split, Stacked: req.Stacked, Lines: req.Lines, RightAxis: req.RightAxis}
	// The figures worked out are given back with the columns the chart is drawn along.
	workedColumns := slices.Clone(columns)
	var drawn, computed []int
	for i, s := range req.Series {
		if !s.drawn() {
			continue
		}
		col := Column{Name: s.ID, Type: datasource.Decimal, Role: "measure", Label: s.Name, Format: s.Format}
		if p := where[i]; p.table != nil {
			from := p.table.Columns[p.at]
			col.Type, col.Format = from.Type, from.Format
		} else {
			computed = append(computed, i)
			workedColumns = append(workedColumns, col)
		}
		columns = append(columns, col)
		viz.Y = append(viz.Y, s.ID)
		drawn = append(drawn, i)
	}
	if len(drawn) == 0 {
		return notDrawn("No series is drawn: draw false is for series used only in expressions.")
	}
	if problem := oneWriting(columns, viz.RightAxis); problem != "" {
		return notDrawn(problem)
	}
	checked := make([]query.OutputColumn, len(columns))
	for i, c := range columns {
		checked[i] = query.OutputColumn{Name: c.Name, Type: c.Type, Role: c.Role, Label: c.Label, Format: c.Format}
	}
	if err := viz.Check(checked); err != nil {
		return notDrawn("The chart cannot be drawn so: " + err.Error() + ".")
	}
	data := make([][]any, len(rows))
	for i, r := range rows {
		cells := []any{r.x}
		if firstSplit != nil {
			cells = append(cells, r.split)
		}
		for _, j := range drawn {
			cells = append(cells, r.cells[j])
		}
		data[i] = cells
	}

	chart := &store.AnswerChart{Title: req.Title, Sources: used, Calculations: calculation}
	var err error
	if chart.Viz, err = json.Marshal(viz); err == nil {
		if chart.Columns, err = json.Marshal(columns); err == nil {
			chart.Rows, err = json.Marshal(data)
		}
	}
	if err != nil {
		return notDrawn("The chart could not be kept: " + err.Error())
	}

	// What the model is told: the notes, and the figures of the series worked out.
	var said strings.Builder
	said.WriteString("Shown: " + req.Title + ".")
	for _, n := range used {
		if tables[n].Truncated {
			fmt.Fprintf(&said, " Source [%d] gave only some of its rows, and the chart has only those: it is not the whole.", n)
		}
	}
	if len(empty) > 0 {
		fmt.Fprintf(&said, " Left empty where a lookup has no figure: %s.", listed(empty))
	}
	if len(unworked) > 0 {
		fmt.Fprintf(&said, " Not worked out, for an input left empty or a divisor of zero: %s.", listed(unworked))
	}
	// Series worked out only on the way to others show nothing of their own.
	if len(computed) == 0 {
		chart.Calculations = nil
		return ToolResult{Content: said.String(), Subject: req.Title, Chart: chart}, nil
	}
	worked := struct {
		Columns   []Column `json:"columns"`
		Rows      [][]any  `json:"rows"`
		Truncated bool     `json:"truncated,omitempty"`
	}{Columns: workedColumns}
	// The figures are those the model is given, as it is shown them.
	var figures []*big.Rat
	for _, r := range rows {
		if len(worked.Rows) == chartRows {
			worked.Truncated = true
			break
		}
		cells := []any{r.x}
		if firstSplit != nil {
			cells = append(cells, r.split)
		}
		for _, i := range computed {
			if r.values[i] != nil {
				figures = append(figures, asShown(r.values[i]))
			}
			cells = append(cells, r.cells[i])
		}
		worked.Rows = append(worked.Rows, cells)
	}
	text, err := json.Marshal(worked)
	if err != nil {
		return notDrawn("The chart could not be kept: " + err.Error())
	}
	said.WriteString(" The series worked out, to cite as this source:\n")
	said.Write(text)
	return ToolResult{Content: said.String(), Subject: req.Title, Chart: chart}, figures
}

func notDrawn(why string) (ToolResult, []*big.Rat) {
	return ToolResult{Content: why, Failed: true}, nil
}

// checkExpression checks a series worked out from those before it, and says
// how it is worked out, for its source.
func checkExpression(s chartSeries, before []chartSeries) (store.ChartCalculation, string) {
	calc := store.ChartCalculation{Series: s.ID, Name: s.Name, Expression: strings.TrimSpace(s.Expression), Inputs: []store.ChartInput{}}
	ones := map[string]*big.Rat{}
	for _, t := range tokenize(calc.Expression) {
		if t.name == "" {
			continue
		}
		i := slices.IndexFunc(before, func(b chartSeries) bool { return b.ID == t.name })
		if i < 0 {
			return calc, fmt.Sprintf("The expression of series %s uses %s, which is not a series before it.", s.ID, t.name)
		}
		if ones[t.name] == nil {
			ones[t.name] = big.NewRat(1, 1)
			calc.Inputs = append(calc.Inputs, store.ChartInput{Name: t.name, Label: before[i].Name, Source: before[i].Source})
		}
	}
	if len(calc.Inputs) == 0 {
		return calc, fmt.Sprintf("The expression of series %s uses no series: work figures out from those looked up.", s.ID)
	}
	// Ones show how the expression is written; a divisor of zero is a row's matter.
	if err := checkWritten(calc.Expression, ones); err != nil {
		return calc, fmt.Sprintf("The expression of series %s: %s.", s.ID, err)
	}
	if s.Format != nil {
		if problem := s.Format.Problem(datasource.Decimal); problem != "" {
			return calc, fmt.Sprintf("The format of series %s has a %s that is not valid.", s.ID, problem)
		}
	}
	return calc, ""
}

// alike says two category columns can be matched: dates only with dates
// truncated alike, text only with text.
func alike(a, b *Column) bool { return a.Type == b.Type && a.Grain == b.Grain }

func kind(c *Column) string {
	if c.Grain != "" {
		return fmt.Sprintf("%s by %s", c.Type, c.Grain)
	}
	return string(c.Type)
}

// oneWriting says what is wrong when series that share a value axis are not
// written alike: an amount and a percentage cannot be read on one axis.
func oneWriting(columns []Column, right []string) string {
	axes := map[bool]*Column{}
	for i := range columns {
		c := &columns[i]
		if c.Role != "measure" {
			continue
		}
		onRight := slices.Contains(right, c.Name)
		other := axes[onRight]
		if other == nil {
			axes[onRight] = c
			continue
		}
		if writing(other.Format) != writing(c.Format) {
			return fmt.Sprintf("%s and %s are written differently (%s, %s) and cannot share a value axis: draw them apart, or as a combo chart with one on the right axis.", other.Label, c.Label, describeWriting(other.Format), describeWriting(c.Format))
		}
	}
	return ""
}

func writing(f *dataset.Format) string {
	if f == nil {
		return "number|||"
	}
	style := f.Style
	if style == "" || style == "none" {
		style = "number"
	}
	return style + "|" + f.Unit + "|" + f.Prefix + "|" + f.Suffix
}

func describeWriting(f *dataset.Format) string {
	parts := strings.Split(writing(f), "|")
	out := parts[0]
	for _, p := range parts[1:] {
		if p != "" {
			out += " " + p
		}
	}
	return out
}

// cellKey is what a category is matched on: numbers by value, the rest as written.
func cellKey(v any) string {
	switch v := v.(type) {
	case nil:
		return "null"
	case string:
		return "s" + v
	case bool:
		return fmt.Sprint("b", v)
	}
	if r, ok := toNumber(v); ok {
		return "n" + r.RatString()
	}
	b, _ := json.Marshal(v)
	return "j" + string(b)
}

func place(x, split any) string {
	if split == nil {
		return fmt.Sprint(x)
	}
	return fmt.Sprintf("%v, %v", x, split)
}

// listed names the first few of many.
func listed(items []string) string {
	const most = 10
	if len(items) <= most {
		return strings.Join(items, "; ")
	}
	return strings.Join(items[:most], "; ") + fmt.Sprintf("; and %d more", len(items)-most)
}
