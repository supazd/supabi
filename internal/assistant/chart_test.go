package assistant

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/store"
)

func chartTables() map[int]*Table {
	yuan := &dataset.Format{Prefix: "¥", Unit: "wan"}
	month := Column{Name: "month", Type: "date", Role: "dimension", Label: "月份", Grain: "month"}
	return map[int]*Table{
		1: {Columns: []Column{month, {Name: "revenue", Type: "decimal", Role: "measure", Label: "销售额", Format: yuan}, {Name: "revenue_last_year", Type: "decimal", Role: "measure", Label: "去年销售额", Format: yuan}, {Name: "orders", Type: "integer", Role: "measure", Label: "订单数"}, {Name: "status", Type: "string", Role: "measure", Label: "最新状态"}},
			Rows: [][]any{{"2026-02-01", "120.5", "100", int64(7), "paid"}, {"2026-01-01", "110", "0", int64(5), "paid"}, {"2026-03-01", "130", "104", int64(9), "open"}}},
		2: {Columns: []Column{{Name: "order_month", Type: "date", Role: "dimension", Label: "下单月", Grain: "month"}, {Name: "revenue", Type: "decimal", Role: "measure", Label: "销售额", Format: yuan}},
			Rows: [][]any{{"2026-01-01", "90"}, {"2026-02-01", "95"}, {"2026-04-01", "99"}}, Truncated: true},
		3: {Columns: []Column{{Name: "week", Type: "date", Role: "dimension", Grain: "week"}, {Name: "revenue", Type: "decimal", Role: "measure", Format: yuan}},
			Rows: [][]any{{"2026-01-05", "10"}}},
		4: {Columns: []Column{{Name: "region", Type: "string", Role: "dimension"}, {Name: "city", Type: "string", Role: "dimension"}, {Name: "revenue", Type: "decimal", Role: "measure", Format: yuan}},
			Rows: [][]any{{"华东", "上海", "50"}, {"华东", "杭州", "30"}, {"华南", "广州", "40"}}},
	}
}

type drawnChart struct {
	viz     map[string]any
	columns []Column
	rows    [][]any
}

func readChart(t *testing.T, c *store.AnswerChart) drawnChart {
	t.Helper()
	var out drawnChart
	for raw, into := range map[string]any{string(c.Viz): &out.viz, string(c.Columns): &out.columns, string(c.Rows): &out.rows} {
		if err := json.Unmarshal([]byte(raw), into); err != nil {
			t.Fatal(err)
		}
	}
	return out
}

// A chart of one lookup draws its rows, in time order, written as its column.
func TestDrawChartOfOneLookup(t *testing.T) {
	out, figures := drawChart(`{"type":"line","title":"华东每月销售额","x":"month","series":[{"id":"sales","name":"销售额","source":1,"column":"revenue"}]}`, chartTables())
	if out.Failed || out.Chart == nil || figures != nil || out.Subject != "华东每月销售额" || out.Content != "Shown: 华东每月销售额." {
		t.Fatalf("out = %+v", out)
	}
	if out.Chart.Calculations != nil || len(out.Chart.Sources) != 1 || out.Chart.Sources[0] != 1 {
		t.Errorf("chart = %+v", out.Chart)
	}
	got := readChart(t, out.Chart)
	if got.viz["type"] != "line" || got.viz["x"] != "month" || len(got.viz["y"].([]any)) != 1 {
		t.Errorf("viz = %v", got.viz)
	}
	if len(got.columns) != 2 || got.columns[1].Label != "销售额" || got.columns[1].Format == nil || got.columns[1].Format.Unit != "wan" || got.columns[0].Grain != "month" {
		t.Errorf("columns = %+v", got.columns)
	}
	if want := `[["2026-01-01","110"],["2026-02-01","120.5"],["2026-03-01","130"]]`; string(out.Chart.Rows) != want {
		t.Errorf("rows = %s, want %s", out.Chart.Rows, want)
	}
}

// Two lookups are matched on their months, each naming its own column; a
// month only one has leaves the other's point empty.
func TestDrawChartOfTwoLookups(t *testing.T) {
	out, _ := drawChart(`{"type":"line","title":"华东、华南","x":"month","series":[{"id":"east","name":"华东","source":1,"column":"revenue"},{"id":"south","name":"华南","source":2,"column":"revenue","x":"order_month"}]}`, chartTables())
	if out.Failed {
		t.Fatalf("out = %+v", out)
	}
	if want := `[["2026-01-01","110","90"],["2026-02-01","120.5","95"],["2026-03-01","130",null],["2026-04-01",null,"99"]]`; string(out.Chart.Rows) != want {
		t.Errorf("rows = %s, want %s", out.Chart.Rows, want)
	}
	for _, want := range []string{"Source [2] gave only some of its rows", "no figure: 华南 2026-03-01; 华东 2026-04-01"} {
		if !strings.Contains(out.Content, want) {
			t.Errorf("content %q lacks %q", out.Content, want)
		}
	}
	if len(out.Chart.Sources) != 2 {
		t.Errorf("sources = %v", out.Chart.Sources)
	}
}

// A series worked out row by row is a source of its own: its figures are
// given back to cite, and a divisor of zero leaves its row empty.
func TestDrawChartWorkedOut(t *testing.T) {
	out, figures := drawChart(`{"type":"bar","title":"同比","x":"month","series":[`+
		`{"id":"now","name":"今年","source":1,"column":"revenue","draw":false},`+
		`{"id":"last","name":"去年","source":1,"column":"revenue_last_year","draw":false},`+
		`{"id":"growth","name":"同比增长率","expression":"(now - last) / last","format":{"style":"percent","decimals":1}}]}`, chartTables())
	if out.Failed {
		t.Fatalf("out = %+v", out)
	}
	if want := `[["2026-01-01",null],["2026-02-01","0.205"],["2026-03-01","0.25"]]`; string(out.Chart.Rows) != want {
		t.Errorf("rows = %s, want %s", out.Chart.Rows, want)
	}
	if len(figures) != 2 || decimalText(figures[0]) != "0.205" {
		t.Errorf("figures = %v", figures)
	}
	calc := out.Chart.Calculations
	if len(calc) != 1 || calc[0].Name != "同比增长率" || len(calc[0].Inputs) != 2 || calc[0].Inputs[0] != (store.ChartInput{Name: "now", Label: "今年", Source: 1}) {
		t.Errorf("calculations = %+v", calc)
	}
	for _, want := range []string{"Not worked out, for an input left empty or a divisor of zero: 同比增长率 2026-01-01", `"rows":[["2026-01-01",null],["2026-02-01","0.205"],["2026-03-01","0.25"]]`, `"label":"同比增长率"`} {
		if !strings.Contains(out.Content, want) {
			t.Errorf("content %q lacks %q", out.Content, want)
		}
	}
	got := readChart(t, out.Chart)
	if len(got.columns) != 2 || got.columns[1].Format.Style != "percent" || got.columns[1].Type != "decimal" {
		t.Errorf("columns = %+v", got.columns)
	}

	// Across lookups, after they are matched; a series only worked out on the way shows nothing.
	out, figures = drawChart(`{"type":"line","title":"华东占华南","x":"month","series":[{"id":"e","name":"华东","source":1,"column":"revenue","draw":false},{"id":"s","name":"华南","source":2,"column":"revenue","x":"order_month","draw":false},{"id":"share","name":"华东/华南","expression":"e / s"}]}`, chartTables())
	if out.Failed || len(figures) != 2 || !strings.Contains(string(out.Chart.Rows), `["2026-01-01","1.222222222"]`) {
		t.Errorf("across lookups: %+v %s", out, out.Chart.Rows)
	}
	// A figure that does not end is kept as the model is shown it, which is what it copies.
	if calc, _ := calculate(`{"expression":"a * 2","inputs":{"a":{"label":"倍数","value":"1.222222222","source":3}}}`, figures2(figures)); calc.Failed || calc.Calculation.Result != "2.444444444" {
		t.Errorf("calculated from the chart: %+v", calc)
	}
	out, figures = drawChart(`{"type":"line","title":"两个","x":"month","series":[{"id":"e","name":"华东","source":1,"column":"revenue"},{"id":"half","name":"一半","expression":"e / 2","draw":false}]}`, chartTables())
	if out.Failed || figures != nil || out.Chart.Calculations != nil {
		t.Errorf("worked out but not drawn: %+v", out)
	}
}

// A split draws one series for each value of a dimension.
func TestDrawChartSplit(t *testing.T) {
	out, _ := drawChart(`{"type":"bar","title":"各城市","x":"city","split":"region","series":[{"id":"sales","name":"销售额","source":4,"column":"revenue"}]}`, chartTables())
	if out.Failed {
		t.Fatalf("out = %+v", out)
	}
	if want := `[["上海","华东","50"],["杭州","华东","30"],["广州","华南","40"]]`; string(out.Chart.Rows) != want {
		t.Errorf("rows = %s, want %s", out.Chart.Rows, want)
	}
	if got := readChart(t, out.Chart); got.viz["series"] != "region" {
		t.Errorf("viz = %v", got.viz)
	}
}

func figures2(f []*big.Rat) figures { return figures{3: f} }

// The model is given at most chartRows rows of the series worked out, and
// only their figures can be calculated with.
func TestDrawChartGivesBackSomeRows(t *testing.T) {
	table := &Table{Columns: []Column{{Name: "k", Type: "string", Role: "dimension"}, {Name: "v", Type: "integer", Role: "measure"}}}
	for i := range 250 {
		table.Rows = append(table.Rows, []any{fmt.Sprint("k", i), int64(i)})
	}
	out, figures := drawChart(`{"type":"bar","title":"t","x":"k","series":[{"id":"v","name":"v","source":1,"column":"v","draw":false},{"id":"d","name":"两倍","expression":"v * 2"}]}`, map[int]*Table{1: table})
	if out.Failed || len(figures) != chartRows || !strings.Contains(out.Content, `"truncated":true`) || strings.Contains(out.Content, `"k200"`) {
		t.Errorf("%d figures: %.200s", len(figures), out.Content)
	}
	if got := readChart(t, out.Chart); len(got.rows) != 250 {
		t.Errorf("the chart draws %d rows", len(got.rows))
	}
}

func TestDrawChartRefused(t *testing.T) {
	east := `{"id":"e","name":"华东","source":1,"column":"revenue"}`
	for arguments, want := range map[string]string{
		`{"type":"scatter","title":"t","x":"month","series":[` + east + `]}`:                                                                                                                                    "not one draw_chart draws",
		`{"type":"line","title":" ","x":"month","series":[` + east + `]}`:                                                                                                                                       "needs a title",
		`{"type":"line","title":"t","x":"month","series":[]}`:                                                                                                                                                   "at least one series",
		`{"type":"line","title":"t","x":"month","series":[` + east + `],"color":"red"}`:                                                                                                                         "not what draw_chart takes",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x","source":9,"column":"revenue"}]}`:                                                                                                "not a query_chart result",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x","source":1,"column":"month"}]}`:                                                                                                  "no measure column \"month\" of numbers",
		`{"type":"line","title":"t","x":"region","series":[` + east + `]}`:                                                                                                                                      "no dimension column \"region\"",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e f","name":"x","source":1,"column":"revenue"}]}`:                                                                                              "is not a name",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,` + east + `]}`:                                                                                                                          "Two series have the id e",
		`{"type":"line","title":"t","x":"month","series":[{"id":"month","name":"x","source":1,"column":"revenue"}]}`:                                                                                            "choose another",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x"}]}`:                                                                                                                              "either a source and a column, or an expression",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x","source":1,"column":"revenue","expression":"1"}]}`:                                                                               "either a source and a column, or an expression",
		`{"type":"line","title":"t","x":"month","series":[{"id":"g","name":"g","expression":"e * 2"},` + east + `]}`:                                                                                            "not a series before it",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"g","name":"g","expression":"(e * 2"}]}`:                                                                                           "parenthesis is not closed",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"g","name":"g","expression":"100"}]}`:                                                                                              "uses no series",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"g","name":"g","expression":"e / (e - e) )"}]}`:                                                                                    "more after its end",
		`{"type":"line","title":"t","x":"month","series":[{"id":"s","name":"状态","source":1,"column":"status"}]}`:                                                                                                "those it has are: revenue, revenue_last_year, orders.",
		`{"type":"line","title":"t","x":"month","series":[{"id":"g","name":"g","expression":"1 + 1"}]}`:                                                                                                         "uses no series",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x","source":1,"column":"revenue","format":{"style":"percent"}}]}`:                                                                   "leave out its format",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"g","name":"g","expression":"e","format":{"decimals":12}}]}`:                                                                       "decimals",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"w","name":"周","source":3,"column":"revenue","x":"week"}]}`:                                                                        "date by month in one lookup and date by week",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"o","name":"订单","source":1,"column":"orders"}]}`:                                                                                   "cannot share a value axis",
		`{"type":"bar","title":"t","x":"region","series":[{"id":"r","name":"r","source":4,"column":"revenue"}]}`:                                                                                                "more than one row for 华东",
		`{"type":"pie","title":"t","x":"month","series":[` + east + `,{"id":"l","name":"l","source":1,"column":"revenue_last_year"}]}`:                                                                          "exactly one measure",
		`{"type":"bar","title":"t","x":"city","split":"region","series":[{"id":"r","name":"r","source":4,"column":"revenue"},{"id":"d","name":"d","expression":"r * 2","format":{"prefix":"¥","unit":"wan"}}]}`: "exactly one measure",
		`{"type":"line","title":"t","x":"month","series":[` + east + `,{"id":"l","name":"l","source":1,"column":"revenue_last_year","draw":false}],"lines":["e"]}`:                                              "lines does not apply",
		`{"type":"line","title":"t","x":"month","series":[{"id":"e","name":"x","source":1,"column":"revenue","draw":false}]}`:                                                                                   "No series is drawn",
	} {
		if out, _ := drawChart(arguments, chartTables()); !out.Failed || out.Chart != nil || !strings.Contains(out.Content, want) {
			t.Errorf("%s: %+v, want %q", arguments, out, want)
		}
	}

	// An amount and a count can be read on the two axes of a combo chart.
	if out, _ := drawChart(`{"type":"combo","title":"t","x":"month","series":[`+east+`,{"id":"o","name":"订单","source":1,"column":"orders"}],"lines":["o"],"rightAxis":["o"]}`, chartTables()); out.Failed {
		t.Errorf("combo: %+v", out)
	}
}
