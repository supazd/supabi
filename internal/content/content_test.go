package content

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

var orders = &dataset.Spec{
	SpecVersion: 1,
	Source:      dataset.Source{Type: "table", Table: "orders"},
	Fields: []dataset.Field{
		{Key: "created", Label: "created", Column: "created_at", Type: datasource.Timestamp, Role: dataset.Dimension},
		{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "amount", Label: "amount", Column: "amount", Type: datasource.Decimal, Role: dataset.Dimension},
		{Key: "revenue", Label: "revenue", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
		{Key: "orders", Label: "orders", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
	},
}

func code(err error) string {
	var e *dataset.Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err != nil {
		return "other: " + err.Error()
	}
	return ""
}

func TestChartValidate(t *testing.T) {
	const q = `"query":{"version":1,"dataset":"d","dimensions":[{"field":"created","grain":"month","alias":"month"},{"field":"region"}],"measures":[{"field":"revenue","agg":"sum"},{"field":"orders","agg":"count"}]}`
	tests := []struct {
		viz  string
		want string
	}{
		{`{"type":"bar","x":"month","y":["revenue","orders"]}`, ""},
		{`{"type":"bar","x":"month","y":["revenue"],"series":"region","stacked":true}`, ""},
		{`{"type":"line","x":"month","y":["revenue"]}`, ""},
		{`{"type":"area","x":"month","y":["revenue"],"stacked":true}`, ""},
		{`{"type":"pie","x":"region","y":["revenue"]}`, ""},
		{`{"type":"kpi","y":["revenue","orders"]}`, ""},
		{`{"type":"table"}`, ""},
		{`{"type":"table","hiddenColumns":["month","revenue"]}`, ""},
		{`{"type":"table","hiddenColumns":["created"]}`, "viz_unknown_column"},
		{`{"type":"table","hiddenColumns":["month","month"]}`, "viz_duplicate_column"},
		{`{"type":"table","hiddenColumns":["month","region","revenue","orders"]}`, "viz_needs_visible_column"},
		{`{"type":"bar","x":"month","y":["revenue"],"hiddenColumns":["region"]}`, "viz_not_applicable"},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"hiddenColumns":["month"]}`, "viz_not_applicable"},
		{`{"type":"table","columnGroups":[{"label":"维度","columns":["month","region"]},{"label":"业绩","columns":[{"label":"金额","columns":["revenue"]},"orders"]}]}`, ""},
		{`{"type":"table","hiddenColumns":["region"],"columnGroups":[{"label":"a","columns":[{"label":"b","columns":[{"label":"c","columns":["region"]}]}]}]}`, ""},
		{`{"type":"table","columnGroups":[{"label":"a","columns":[{"label":"b","columns":[{"label":"c","columns":[{"label":"d","columns":["region"]}]}]}]}]}`, "viz_invalid_column_groups"},
		// Columns between a group's own count even when hidden, so showing them again cannot split it.
		{`{"type":"table","hiddenColumns":["region"],"columnGroups":[{"label":"a","columns":["month","revenue"]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":["region","month"]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":["region"]},{"label":"b","columns":["month"]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":["month",{"label":"b","columns":["revenue"]}]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":" ","columns":["month"]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"` + strings.Repeat("名", 50) + `","columns":["month"]}]}`, ""},
		{`{"type":"table","columnGroups":[{"label":"` + strings.Repeat("名", 51) + `","columns":["month"]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":[]}]}`, "viz_invalid_column_groups"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":["created"]}]}`, "viz_unknown_column"},
		{`{"type":"table","columnGroups":[{"label":"a","columns":["month"]},{"label":"b","columns":["month"]}]}`, "viz_duplicate_column"},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"columnGroups":[{"label":"a","columns":["region"]}]}`, "viz_not_applicable"},

		{`{"type":"radar","x":"month","y":["revenue"]}`, "viz_unknown_type"},
		{`{"type":"bar","y":["revenue"]}`, "viz_needs_x"},
		{`{"type":"bar","x":"month"}`, "viz_needs_measure"},
		{`{"type":"bar","x":"nope","y":["revenue"]}`, "viz_unknown_column"},
		{`{"type":"bar","x":"created","y":["revenue"]}`, "viz_unknown_column"}, // the alias is month, not the field key
		{`{"type":"bar","x":"revenue","y":["orders"]}`, "viz_wrong_role"},
		{`{"type":"bar","x":"month","y":["region"]}`, "viz_wrong_role"},
		{`{"type":"bar","x":"month","y":["revenue","revenue"]}`, "viz_duplicate_column"},
		{`{"type":"bar","x":"month","y":["revenue"],"series":"month"}`, "viz_duplicate_column"},
		{`{"type":"bar","x":"month","y":["revenue","orders"],"series":"region"}`, "viz_series_needs_one_measure"},
		{`{"type":"line","x":"month","y":["revenue"],"stacked":true}`, "viz_not_applicable"},
		{`{"type":"pie","x":"region","y":["revenue","orders"]}`, "viz_needs_one_measure"},
		{`{"type":"pie","x":"region","y":["revenue"],"series":"month"}`, "viz_not_applicable"},
		{`{"type":"kpi","x":"month","y":["revenue"]}`, "viz_not_applicable"},
		{`{"type":"kpi"}`, "viz_needs_measure"},
		{`{"type":"table","y":["revenue"]}`, "viz_not_applicable"},

		{`{"type":"hbar","x":"region","y":["revenue"],"stacked":true}`, ""},
		{`{"type":"combo","x":"month","y":["revenue","orders"],"lines":["orders"],"rightAxis":["orders"]}`, ""},
		{`{"type":"combo","x":"month","y":["revenue"]}`, "viz_measure_count"},
		{`{"type":"combo","x":"month","y":["revenue","orders"],"lines":["region"]}`, "viz_unknown_column"},
		{`{"type":"combo","x":"month","y":["revenue","orders"],"rightAxis":["orders","orders"]}`, "viz_duplicate_column"},
		{`{"type":"combo","x":"month","y":["revenue","orders"],"series":"region"}`, "viz_not_applicable"},
		{`{"type":"bar","x":"month","y":["revenue"],"lines":["revenue"]}`, "viz_not_applicable"},
		{`{"type":"scatter","x":"region","y":["revenue","orders"],"series":"month"}`, ""},
		{`{"type":"scatter","x":"region","y":["revenue"]}`, "viz_measure_count"},
		{`{"type":"funnel","x":"region","y":["revenue"]}`, ""},
		{`{"type":"funnel","x":"region","y":["revenue"],"series":"month"}`, "viz_not_applicable"},
		{`{"type":"treemap","x":"region","y":["revenue"],"series":"month"}`, ""},
		{`{"type":"treemap","x":"region","y":["revenue","orders"]}`, "viz_needs_one_measure"},
		{`{"type":"heatmap","rows":["region"],"columns":["month"],"y":["revenue"]}`, ""},
		{`{"type":"heatmap","rows":["region"],"columns":["region"],"y":["revenue"]}`, "viz_duplicate_column"},
		{`{"type":"heatmap","rows":["region"],"y":["revenue"]}`, "viz_needs_one_dimension"},
		{`{"type":"heatmap","x":"month","rows":["region"],"columns":["month"],"y":["revenue"]}`, "viz_not_applicable"},
		{`{"type":"bar","x":"month","y":["revenue"],"rows":["region"]}`, "viz_not_applicable"},
		{`{"type":"gauge","y":["revenue","orders"]}`, ""},
		{`{"type":"gauge","y":["revenue"],"style":{"gauge":{"min":0,"max":5000}}}`, ""},
		{`{"type":"gauge","y":["revenue","orders"],"style":{"gauge":{"max":5000}}}`, "viz_not_applicable"},
		{`{"type":"gauge","y":["revenue"],"style":{"gauge":{"min":10,"max":5}}}`, "viz_invalid_style"},
		{`{"type":"gauge","x":"month","y":["revenue"]}`, "viz_not_applicable"},

		{`{"type":"bar","x":"month","y":["revenue","orders"],"stacked":true,"style":{"legend":"bottom","labels":"value","palette":"warm","colors":{"orders":"aqua"},"percent":true,"barWidth":40,"xAxis":{"rotate":45,"title":"月"},"yAxis":{"min":0,"max":100,"hideGrid":true}}}`, ""},
		{`{"type":"line","x":"month","y":["revenue"],"style":{"smooth":true,"points":true}}`, ""},
		{`{"type":"pie","x":"region","y":["revenue"],"style":{"solid":true,"labels":"percent","legend":"none"}}`, ""},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"legend":"middle"}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"labels":"percent"}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"smooth":true}}`, "viz_not_applicable"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"percent":true}}`, "viz_invalid_style"}, // only on a stack
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"barWidth":200}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"colors":{"revenue":"pink"}}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"colors":{"orders":"blue"}}}`, "viz_unknown_column"},
		{`{"type":"bar","x":"month","y":["revenue"],"series":"region","style":{"colors":{"revenue":"blue"}}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"xAxis":{"min":0}}}`, "viz_not_applicable"}, // a category axis
		{`{"type":"hbar","x":"region","y":["revenue"],"style":{"xAxis":{"min":0},"yAxis":{"rotate":90}}}`, ""},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"yAxis":{"min":5,"max":5}}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"xAxis":{"rotate":30}}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"y2Axis":{"title":"x"}}}`, "viz_not_applicable"},
		{`{"type":"kpi","y":["revenue"],"style":{"legend":"top"}}`, "viz_not_applicable"},
		{`{"type":"table","style":{"xAxis":{}}}`, "viz_not_applicable"},

		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue","orders"]}`, ""},
		{`{"type":"pivot","rows":["region","month"],"y":["revenue"]}`, ""},
		{`{"type":"pivot","rows":["region"],"y":["revenue"]}`, "viz_pivot_unplaced"},
		{`{"type":"pivot","rows":["region"],"columns":["region","month"],"y":["revenue"]}`, "viz_duplicate_column"},
		{`{"type":"pivot","rows":["region","month"]}`, "viz_needs_measure"},
		{`{"type":"pivot","rows":["revenue"],"columns":["region","month"],"y":["orders"]}`, "viz_wrong_role"},
		{`{"type":"table","style":{"striped":true,"density":"compact","freeze":true,"widths":{"region":120},"columnAlign":{"revenue":"center"}}}`, ""},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"style":{"striped":true}}`, ""},
		{`{"type":"table","style":{"widths":{"region":10}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"widths":{"nope":100}}}`, "viz_unknown_column"},
		{`{"type":"table","style":{"columnAlign":{"region":"justify"}}}`, "viz_invalid_style"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"striped":true}}`, "viz_not_applicable"},
		{`{"type":"table","style":{"merge":true}}`, ""},
		{`{"type":"table","style":{"paging":"pages","pageSize":50}}`, ""},
		{`{"type":"table","style":{"paging":"auto"}}`, ""},
		{`{"type":"table","style":{"paging":"pages"}}`, ""},
		{`{"type":"table","style":{"paging":"scroll"}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"paging":"auto","pageSize":20}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"pageSize":20}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"paging":"pages","pageSize":1001}}`, "viz_invalid_style"},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"style":{"paging":"auto"}}`, "viz_not_applicable"},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"style":{"merge":true}}`, "viz_not_applicable"},
		{`{"type":"table","style":{"highlights":{"revenue":[{"op":"lt","value":0.8,"color":"red","icon":"down"},{"op":"gte","value":1,"color":"green"}],"orders":[{"op":"eq","value":0,"color":"yellow","icon":"dot"}]}}}`, ""},
		{`{"type":"pivot","rows":["region"],"columns":["month"],"y":["revenue"],"style":{"highlights":{"revenue":[{"op":"ne","value":-1.5,"color":"blue","icon":"up"}]}}}`, ""},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"highlights":{"revenue":[{"op":"lt","value":1,"color":"red"}]}}}`, "viz_not_applicable"},
		{`{"type":"table","style":{"highlights":{"nope":[{"op":"lt","value":1,"color":"red"}]}}}`, "viz_unknown_column"},
		{`{"type":"table","style":{"highlights":{"region":[{"op":"lt","value":1,"color":"red"}]}}}`, "viz_highlight_not_supported"},
		{`{"type":"table","style":{"highlights":{"month":[{"op":"lt","value":1,"color":"red"}]}}}`, "viz_highlight_not_supported"},
		{`{"type":"table","style":{"highlights":{"revenue":[]}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"highlights":{"revenue":[` + strings.Repeat(`{"op":"lt","value":1,"color":"red"},`, 5) + `{"op":"lt","value":1,"color":"red"}]}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"highlights":{"revenue":[{"op":"between","value":1,"color":"red"}]}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"highlights":{"revenue":[{"op":"lt","color":"red"}]}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"highlights":{"revenue":[{"op":"lt","value":1,"color":"pink"}]}}}`, "viz_invalid_style"},
		{`{"type":"table","style":{"highlights":{"revenue":[{"op":"lt","value":1,"color":"red","icon":"star"}]}}}`, "viz_invalid_style"},
		{`{"type":"kpi","y":["revenue","orders"],"compare":{"revenue":"orders"},"style":{"textAlign":"center","size":"large","compareAs":"both","redUp":true}}`, ""},
		{`{"type":"kpi","y":["revenue","orders"],"style":{"compareAs":"diff"}}`, "viz_invalid_style"},
		{`{"type":"kpi","y":["revenue","orders"],"compare":{"revenue":"revenue"}}`, "viz_invalid_compare"},
		{`{"type":"kpi","y":["revenue","orders"],"compare":{"revenue":"orders","orders":"revenue"}}`, "viz_invalid_compare"},
		{`{"type":"kpi","y":["revenue"],"compare":{"revenue":"orders"}}`, "viz_unknown_column"},
		{`{"type":"bar","x":"month","y":["revenue","orders"],"compare":{"revenue":"orders"}}`, "viz_not_applicable"},

		{`{"type":"sankey","levels":["region","month"],"y":["revenue"],"style":{"nodeAlign":"left","labels":"percent","palette":"fresh"}}`, ""},
		{`{"type":"sankey","levels":["region"],"y":["revenue"]}`, "viz_sankey_levels"},
		{`{"type":"sankey","levels":["region","month"],"y":["revenue","orders"]}`, "viz_needs_one_measure"},
		{`{"type":"sankey","levels":["region","region"],"y":["revenue"]}`, "viz_duplicate_column"},
		{`{"type":"sankey","levels":["region","revenue"],"y":["orders"]}`, "viz_wrong_role"},
		{`{"type":"sankey","x":"region","levels":["region","month"],"y":["revenue"]}`, "viz_not_applicable"},
		{`{"type":"bar","x":"month","y":["revenue"],"levels":["region","month"]}`, "viz_not_applicable"},
		{`{"type":"bar","x":"month","y":["revenue"],"style":{"nodeAlign":"left"}}`, "viz_not_applicable"},
		{`{"type":"sankey","levels":["region","month"],"y":["revenue"],"style":{"nodeAlign":"middle"}}`, "viz_invalid_style"},

		{`{"type":"table","formats":{"revenue":{"unit":"wan","decimals":1},"orders":{"grouping":false}}}`, ""},
		{`{"type":"table","formats":{"revenue":{"style":"none"}}}`, ""}, // the dataset's format set aside
		{`{"type":"table","formats":{"nope":{}}}`, "viz_unknown_column"},
		{`{"type":"table","formats":{"region":{}}}`, "viz_format_not_supported"},
		{`{"type":"table","formats":{"revenue":{"style":"percent","unit":"K"}}}`, "viz_invalid_format"},
		{`{"type":"table","formats":{"month":{"date":"chinese","time":"minute","week":"number"}}}`, ""},
		{`{"type":"table","formats":{"month":{}}}`, ""}, // the dataset's format set aside for the default one
		{`{"type":"table","formats":{"month":{"style":"none"}}}`, "viz_invalid_format"},
		{`{"type":"table","formats":{"month":{"prefix":"¥"}}}`, "viz_invalid_format"},
		{`{"type":"table","formats":{"month":{"date":"iso"}}}`, "viz_invalid_format"},
		{`{"type":"table","formats":{"revenue":{"date":"dash"}}}`, "viz_invalid_format"},
	}
	for _, tt := range tests {
		var spec ChartSpec
		if err := json.Unmarshal([]byte(`{"specVersion":1,`+q+`,"viz":`+tt.viz+`}`), &spec); err != nil {
			t.Fatal(err)
		}
		if got := code(spec.Validate(orders, dialect.Postgres{})); got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.viz, got, tt.want)
		}
	}

	// A query that does not compile makes the chart invalid, with the query's own error.
	var spec ChartSpec
	_ = json.Unmarshal([]byte(`{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"nope"}]},"viz":{"type":"table"}}`), &spec)
	if got := code(spec.Validate(orders, dialect.Postgres{})); got != "unknown_field" {
		t.Errorf("broken query: got %q", got)
	}
	spec.SpecVersion = 2
	if got := code(spec.Validate(orders, dialect.Postgres{})); got != "unsupported_spec_version" {
		t.Errorf("future version: got %q", got)
	}
}

func TestDashboardValidate(t *testing.T) {
	tests := []struct {
		spec string
		want string
	}{
		{`{"specVersion":1,"layout":{"columns":12,"items":[]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"ch_1","x":0,"y":0,"w":8,"h":4},{"id":"b","type":"chart","chartId":"ch_1","x":8,"y":0,"w":4,"h":4}]}}`, ""},
		{`{"specVersion":2,"layout":{"columns":12,"items":[]}}`, "unsupported_spec_version"},
		{`{"specVersion":1,"layout":{"columns":24,"items":[]}}`, "invalid_layout"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"A b","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1},{"id":"a","type":"chart","chartId":"c","x":1,"y":0,"w":1,"h":1}]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"video","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_type"},
		// An empty chart widget is laid out before its chart is chosen.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","x":0,"y":0,"w":1,"h":1,"title":"华东","note":"口径","hideHeader":true}]}}`, ""},
		// Titles and text are written by the author; they name no chart.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":12,"h":1,"useDashboardName":true},{"id":"b","type":"title","x":0,"y":1,"w":12,"h":1,"title":"华东区","subtitle":"按下单日期"},{"id":"c","type":"text","x":0,"y":2,"w":6,"h":2,"markdown":"**口径**"}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":12,"h":1},{"id":"b","type":"text","x":0,"y":1,"w":12,"h":1}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","chartId":"c","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_fields"},
		// A title's style takes the values it lists, a hue of the palette for the background.
		// A title's style places its words; a frame dresses any widget.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":12,"h":1,"useDashboardName":true,"style":{"align":"center","verticalAlign":"bottom"},"frame":{"background":"magenta","border":true}},{"id":"b","type":"title","x":0,"y":1,"w":12,"h":1,"style":{"align":"right","verticalAlign":"top"},"frame":{"background":"neutral","border":false,"padding":"compact"}},{"id":"c","type":"title","x":0,"y":2,"w":12,"h":1,"style":{},"frame":{}}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"style":{"align":"justify"}}]}}`, "invalid_item_style"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"style":{"verticalAlign":"center"}}]}}`, "invalid_item_style"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"#1f3a5f","backgroundDark":"#0D1B2A"}},{"id":"b","type":"text","x":0,"y":1,"w":1,"h":1,"frame":{"background":"#FFAA00","padding":"comfortable"}},{"id":"c","type":"chart","chartId":"ch","x":1,"y":1,"w":1,"h":1,"frame":{"background":"blue","border":false}},{"id":"d","type":"chart","chartId":"ch","x":2,"y":1,"w":1,"h":1,"frame":{"background":"default"}}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"#f00"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"#1f3a5g"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"#+1f3a5"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"rgb(1,2,3)"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"frame":{"background":"surface"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"padding":"tight"}}]}}`, "invalid_item_frame"},
		// The dark scheme takes any background of its own, with or without a light one.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"background":"blue","backgroundDark":"#0d1b2a"}},{"id":"b","type":"text","x":0,"y":1,"w":1,"h":1,"frame":{"backgroundDark":"default"}},{"id":"c","type":"text","x":0,"y":2,"w":1,"h":1,"frame":{"background":"#fff3c4","backgroundDark":"neutral"}}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"background":"#1f3a5f","backgroundDark":"navy"}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"backgroundDark":"#123"}}]}}`, "invalid_item_frame"},
		// Transparency is a percentage, the same in both schemes.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"frame":{"transparency":0}},{"id":"b","type":"text","x":0,"y":1,"w":1,"h":1,"frame":{"background":"#1f3a5f","transparency":100}}]},"frame":{"transparency":40}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"transparency":101}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"transparency":-5}}]}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"frame":{"background":"none"}}]}}`, "invalid_item_frame"},
		// The dashboard's own frame and the query container's are checked alike.
		{`{"specVersion":1,"layout":{"columns":12,"items":[]},"frame":{"border":false,"padding":"compact","background":"neutral"},"queryContainer":{"x":0,"y":0,"w":12,"h":2,"frame":{"background":"#eef2ff","border":true}}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[]},"frame":{"padding":"wide"}}`, "invalid_item_frame"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[]},"queryContainer":{"x":0,"y":0,"w":12,"h":2,"frame":{"background":"teal"}}}`, "invalid_item_frame"},
		// A name, a note and a hidden header are a chart widget's alone.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"style":{"align":"left"}}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"style":{}}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"subtitle":"x"}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1,"note":"x"}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":1,"h":1,"hideHeader":true}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"title":"` + strings.Repeat("名", 201) + `"}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"note":"` + strings.Repeat("注", 501) + `"}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1,"note":"` + strings.Repeat("注", 500) + `"}]}}`, ""},
		// An empty chart widget can be neither filtered nor linked.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","x":0,"y":0,"w":1,"h":1}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"a","field":"region"}]}]}`, "invalid_filter_target"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1},{"id":"b","type":"chart","x":1,"y":0,"w":1,"h":1}]},"links":[{"id":"l","label":"l","source":{"item":"a","column":"region"},"targets":[{"item":"b","field":"region"}]}]}`, "invalid_link"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","markdown":"x","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","useDashboardName":true,"title":"x","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","subtitle":"x","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","markdown":"x","x":0,"y":0,"w":1,"h":1}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","title":"` + strings.Repeat("标", 201) + `","x":0,"y":0,"w":1,"h":1}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","title":"` + strings.Repeat("标", 200) + `","x":0,"y":0,"w":1,"h":1}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","markdown":"` + strings.Repeat("a", 20001) + `","x":0,"y":0,"w":1,"h":1}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":13,"h":1}]}}`, "invalid_item_position"},
		// Only charts can be filtered or linked.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"title","x":0,"y":0,"w":1,"h":1}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"a","field":"region"}]}]}`, "invalid_filter_target"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1},{"id":"b","type":"text","x":1,"y":0,"w":1,"h":1}]},"links":[{"id":"l","label":"l","source":{"item":"a","column":"region"},"targets":[{"item":"b","field":"region"}]}]}`, "invalid_link"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":1,"h":1},{"id":"b","type":"text","x":1,"y":0,"w":1,"h":1}]},"links":[{"id":"l","label":"l","source":{"item":"b","column":"region"},"targets":[{"item":"a","field":"region"}]}]}`, "invalid_link"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":8,"y":0,"w":5,"h":1}]}}`, "invalid_item_position"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":0,"h":1}]}}`, "invalid_item_position"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":-1,"w":1,"h":1}]}}`, "invalid_item_position"},
		// A tab container switches between chart widgets of its own, which can be filtered and linked as any other.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"frame":{"border":false},"tabs":[{"id":"b","chartId":"c","title":"销售额","note":"口径"},{"id":"d"}]},{"id":"e","type":"chart","chartId":"c","x":6,"y":0,"w":6,"h":4}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"b","field":"region"}]}],"links":[{"id":"l","label":"l","source":{"item":"e","column":"region"},"targets":[{"item":"b","field":"region"}]}]}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","chartId":"c"}]}]}}`, "invalid_tabs"},
		// The tab shown first is one of the container's own.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"defaultTab":"d","tabs":[{"id":"b","chartId":"c"},{"id":"d"}]}]}}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"defaultTab":"e","tabs":[{"id":"b","chartId":"c"},{"id":"d"}]},{"id":"e","type":"chart","chartId":"c","x":6,"y":0,"w":6,"h":4}]}}`, "invalid_default_tab"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":6,"h":4,"defaultTab":"a"}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4}]}}`, "invalid_tabs"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[` + strings.Repeat(`{"id":"t"},`, 20) + `{"id":"t"}]}]}}`, "invalid_tabs"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","chartId":"c","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d"}]}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","hideHeader":true,"x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d"}]}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"chart","chartId":"c","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d"}]}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","x":0,"y":0,"w":6,"h":4,"tabs":[]}]}}`, "invalid_item_fields"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","title":"` + strings.Repeat("名", 201) + `"},{"id":"d"}]}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d","note":"` + strings.Repeat("注", 501) + `"}]}]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"D d"}]}]}}`, "invalid_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"b"}]}]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"a"}]}]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d"}]},{"id":"b","type":"text","x":6,"y":0,"w":6,"h":4}]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":8,"y":0,"w":6,"h":4,"tabs":[{"id":"b"},{"id":"d"}]}]}}`, "invalid_item_position"},
		// An empty tab, like an empty chart widget, and the container itself can be neither filtered nor linked.
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","chartId":"c"},{"id":"d"}]}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"d","field":"region"}]}]}`, "invalid_filter_target"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","chartId":"c"},{"id":"d"}]}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"a","field":"region"}]}]}`, "invalid_filter_target"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","chartId":"c"},{"id":"d"}]}]},"links":[{"id":"l","label":"l","source":{"item":"b","column":"region"},"targets":[{"item":"d","field":"region"}]}]}`, "invalid_link"},
		// A dashboard split into pages: widgets name their page, those above the tabs none. Each grid starts at the top.
		// Filters and links reach charts on any page.
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":"概览"},{"id":"p2","name":"渠道"}],"items":[{"id":"t","type":"title","x":0,"y":0,"w":12,"h":8,"useDashboardName":true},{"id":"a","type":"chart","chartId":"c","page":"p1","x":0,"y":0,"w":6,"h":4},{"id":"b","type":"chart","chartId":"c","page":"p2","x":0,"y":0,"w":6,"h":4}]},"filters":[{"id":"g","label":"x","op":"in","control":{"type":"select"},"targets":[{"item":"a","field":"region"},{"item":"b","field":"region"}]}],"links":[{"id":"l","label":"l","source":{"item":"a","column":"region"},"targets":[{"item":"b","field":"region"}]}]}`, ""},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":"概览"}],"items":[]}}`, "invalid_pages"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[],"items":[]}}`, "invalid_pages"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[` + strings.Repeat(`{"id":"p","name":"p"},`, 20) + `{"id":"p","name":"p"}],"items":[]}}`, "invalid_pages"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":"概览"},{"id":"p1","name":"渠道"}],"items":[]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"a","name":"概览"},{"id":"p2","name":"渠道"}],"items":[{"id":"a","type":"text","x":0,"y":0,"w":6,"h":4}]}}`, "duplicate_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"P 1","name":"概览"},{"id":"p2","name":"渠道"}],"items":[]}}`, "invalid_item_id"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":" "},{"id":"p2","name":"渠道"}],"items":[]}}`, "invalid_page_name"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":"` + strings.Repeat("页", 51) + `"},{"id":"p2","name":"渠道"}],"items":[]}}`, "item_text_too_long"},
		{`{"specVersion":1,"layout":{"columns":12,"pages":[{"id":"p1","name":"概览"},{"id":"p2","name":"渠道"}],"items":[{"id":"a","type":"text","page":"p3","x":0,"y":0,"w":6,"h":4}]}}`, "invalid_item_page"},
		{`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"text","page":"p1","x":0,"y":0,"w":6,"h":4}]}}`, "invalid_item_page"},
	}
	for _, tt := range tests {
		var spec DashboardSpec
		if err := json.Unmarshal([]byte(tt.spec), &spec); err != nil {
			t.Fatal(err)
		}
		if got := code(spec.Validate()); got != tt.want {
			t.Errorf("%s\n  got %q, want %q", tt.spec, got, tt.want)
		}
	}

	var spec DashboardSpec
	_ = json.Unmarshal([]byte(tests[1].spec), &spec)
	if ids := spec.ChartIDs(); len(ids) != 1 || ids[0] != "ch_1" {
		t.Errorf("ChartIDs = %v", ids)
	}

	// The charts in tabs are the dashboard's charts, and each tab is found by its id as a chart widget.
	spec = DashboardSpec{}
	_ = json.Unmarshal([]byte(`{"specVersion":1,"layout":{"columns":12,"items":[{"id":"a","type":"tabs","x":0,"y":0,"w":6,"h":4,"tabs":[{"id":"b","chartId":"ch_2","title":"销售额","note":"口径"},{"id":"d"},{"id":"f","chartId":"ch_3"}]},{"id":"e","type":"chart","chartId":"ch_1","x":6,"y":0,"w":6,"h":4}]}}`), &spec)
	if ids := spec.ChartIDs(); !slices.Equal(ids, []string{"ch_2", "ch_3", "ch_1"}) {
		t.Errorf("ChartIDs with tabs = %v", ids)
	}
	if ids := spec.ChartIDsOf("f", "e"); !slices.Equal(ids, []string{"ch_3", "ch_1"}) {
		t.Errorf("ChartIDsOf tabs = %v", ids)
	}
	if item, ok := spec.ItemByID("b"); !ok || !reflect.DeepEqual(item, Item{ID: "b", Type: ItemChart, ChartID: "ch_2", Title: "销售额", Note: "口径"}) {
		t.Errorf("ItemByID(tab) = %+v, %v", item, ok)
	}
	if item, ok := spec.ItemByID("d"); !ok || item.HoldsChart() {
		t.Errorf("ItemByID(empty tab) = %+v, %v", item, ok)
	}
	if !spec.IsChart("f") || spec.IsChart("d") || spec.IsChart("a") {
		t.Error("IsChart should hold for a tab with a chart only")
	}
}

func chartSpec(t *testing.T, body string) *ChartSpec {
	t.Helper()
	var spec ChartSpec
	if err := json.Unmarshal([]byte(body), &spec); err != nil {
		t.Fatal(err)
	}
	return &spec
}

func TestChartFilters(t *testing.T) {
	const head = `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"revenue","agg":"sum"}]},"viz":{"type":"kpi","y":["revenue"]},"filters":[`
	tests := map[string]string{
		// Fixed, interactive and exposed.
		`{"id":"f1","field":"region","op":"in","value":["east"]}`:                                                                                      "",
		`{"id":"f1","field":"region","op":"not_null"}`:                                                                                                 "",
		`{"id":"f1","field":"region","op":"in","label":"Region","control":{"type":"select","multi":true}}`:                                             "",
		`{"id":"f1","field":"region","op":"contains","label":"Region","control":{"type":"text"},"exposed":true}`:                                       "",
		`{"id":"f1","field":"amount","op":"between","value":[10,null],"label":"Amount","control":{"type":"number_range"}}`:                             "",
		`{"id":"f1","field":"created","op":"time","value":{"last":{"n":30,"unit":"day"}},"label":"When","control":{"type":"relative"},"exposed":true}`: "",
		`{"id":"f1","field":"created","op":"time","value":{},"label":"When","control":{"type":"date_range"}}`:                                          "",

		`{"id":"F 1","field":"region","op":"in","value":["east"]}`:                                                  "invalid_filter_id",
		`{"id":"f1","field":"region","op":"in","value":["a"]},{"id":"f1","field":"region","op":"in","value":["b"]}`: "duplicate_filter_id",
		`{"id":"f1","field":"nope","op":"in","value":["east"]}`:                                                     "unknown_field",
		`{"id":"f1","field":"region","op":"and"}`:                                                                   "invalid_filter",
		`{"id":"f1","field":"region","op":"in"}`:                                                                    "filter_needs_value",
		`{"id":"f1","field":"region","op":"in","value":[]}`:                                                         "filter_needs_value",
		`{"id":"f1","field":"region","op":"in","value":["east"],"exposed":true}`:                                    "",
		`{"id":"f1","field":"region","op":"in","control":{"type":"select"}}`:                                        "filter_needs_label",
		`{"id":"f1","field":"region","op":"in","label":"x","control":{"type":"slider"}}`:                            "invalid_filter_control",
		`{"id":"f1","field":"region","op":"in","label":"x","control":{"type":"relative"}}`:                          "invalid_filter_control",
		`{"id":"f1","field":"amount","op":"contains","label":"x","control":{"type":"text"}}`:                        "invalid_filter_control",
		`{"id":"f1","field":"region","op":"between","label":"x","control":{"type":"number_range"}}`:                 "invalid_filter_control",
		`{"id":"f1","field":"created","op":"in","label":"x","control":{"type":"select"}}`:                           "invalid_filter_control",
		`{"id":"f1","field":"region","op":"in","value":["a","b"],"label":"x","control":{"type":"select"}}`:          "invalid_filter_value",
		`{"id":"f1","field":"region","op":"in","value":"a","label":"x","control":{"type":"select"}}`:                "invalid_filter_value",
		`{"id":"f1","field":"amount","op":"between","value":[1],"label":"x","control":{"type":"number_range"}}`:     "invalid_filter_value",
		// What the structure allows, the query still has to accept.
		`{"id":"f1","field":"amount","op":"eq","value":"abc"}`:                            "invalid_filter_value",
		`{"id":"f1","field":"region","op":"time","value":{"current":"month"}}`:            "time_field_required",
		`{"id":"f1","field":"created","op":"time","value":{"last":{"n":0,"unit":"day"}}}`: "invalid_time_range",
		`{"id":"f1","field":"created","op":"like","value":"x"}`:                           "invalid_filter_value",
	}
	for body, want := range tests {
		spec := chartSpec(t, head+body+`]}`)
		if got := code(spec.Validate(orders, dialect.Postgres{})); got != want {
			t.Errorf("%s\n  got %q, want %q", body, got, want)
		}
	}
}

func TestChartConditions(t *testing.T) {
	spec := chartSpec(t, `{"query":{"filter":{"field":"amount","op":"gt","value":0}},"filters":[
		{"id":"fixed","field":"region","op":"in","value":["east"]},
		{"id":"when","field":"created","op":"time","value":{"current":"year"},"label":"When","control":{"type":"relative"}},
		{"id":"amount","field":"amount","op":"between","label":"Amount","control":{"type":"number_range"}},
		{"id":"name","field":"region","op":"contains","label":"Name","control":{"type":"text"}}]}`)

	ops := func(q query.Query) string {
		if q.Filter == nil {
			return ""
		}
		var out []string
		for _, arg := range q.Filter.Args {
			out = append(out, arg.Field+" "+arg.Op)
		}
		return strings.Join(out, ", ")
	}
	// Empty values restrict nothing; the query's own filter comes first, as one unit.
	q, err := spec.ForViewer(nil, orders)
	if err != nil || ops(q) != "amount gt, region in, created time" {
		t.Errorf("defaults: %q, %v", ops(q), err)
	}
	// A viewer's value takes the place of the filter's own, and an empty one lifts it.
	q, err = spec.ForViewer(map[string]any{"when": map[string]any{}, "amount": []any{nil, float64(5)}, "name": "x"}, orders)
	if err != nil || ops(q) != "amount gt, region in, amount lte, region contains" {
		t.Errorf("chosen: %q, %v", ops(q), err)
	}
	q, _ = spec.ForViewer(map[string]any{"amount": []any{float64(1), float64(5)}}, orders)
	if got := q.Filter.Args[3]; got.Op != "between" {
		t.Errorf("both sides given: %+v", got)
	}
	// Only interactive filters are a viewer's to set.
	for _, id := range []string{"fixed", "nope"} {
		if _, err := spec.ForViewer(map[string]any{id: []any{"west"}}, orders); code(err) != "filter_not_interactive" {
			t.Errorf("setting %q: got %q", id, code(err))
		}
	}
	if spec.Query.Filter.Op != "gt" {
		t.Error("ForViewer modified the chart's own query")
	}
}

func TestAnd(t *testing.T) {
	extra := []dataset.Filter{{Field: "region", Op: "in", Value: []any{"a"}}}
	if got := And(query.Query{}, nil); got.Filter != nil {
		t.Error("no conditions should leave the query alone")
	}
	if got := And(query.Query{}, extra); got.Filter.Op != "and" || len(got.Filter.Args) != 1 {
		t.Errorf("without an own filter: %+v", got.Filter)
	}
	own := &dataset.Filter{Op: "or", Args: []dataset.Filter{{Field: "x", Op: "is_null"}, {Field: "y", Op: "is_null"}}}
	got := And(query.Query{Filter: own}, extra)
	// The chart's own filter stays one unit: an OR inside it cannot swallow the added condition.
	if got.Filter.Op != "and" || len(got.Filter.Args) != 2 || got.Filter.Args[0].Op != "or" || got.Filter.Args[1].Field != "region" {
		t.Errorf("with an own filter: %+v", got.Filter)
	}
	if own.Op != "or" || len(own.Args) != 2 {
		t.Error("And modified the chart's own filter")
	}
}

func TestDashboardFilters(t *testing.T) {
	const base = `{"specVersion":1,"layout":{"columns":12,"items":[{"id":"w1","type":"chart","chartId":"a","x":0,"y":0,"w":1,"h":1},{"id":"w2","type":"chart","chartId":"b","x":1,"y":0,"w":1,"h":1}]},"filters":[`
	tests := map[string]string{
		`{"id":"g1","label":"地区","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"},{"item":"w2","filter":"f"}],"optionsFrom":"w2","default":["华东"]}`:                            "",
		`{"id":"G 1","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}]}`:                                                                                           "invalid_filter_id",
		`{"id":"g1","label":" ","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}]}`:                                                                                            "filter_needs_label",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[]}`:                                                                                                                      "filter_needs_target",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[{"item":"w9","filter":"f"}]}`:                                                                                            "invalid_filter_target",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":""}]}`:                                                                                             "invalid_filter_target",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}],"optionsFrom":"w2"}`:                                                                         "invalid_filter_options",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}]},{"id":"g1","label":"y","control":{"type":"select"},"targets":[{"item":"w2","filter":"f"}]}`: "duplicate_filter_id",
		`{"id":"g1","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}]},{"id":"g2","label":"y","control":{"type":"select"},"targets":[{"item":"w1","filter":"f"}]}`: "",
	}
	for body, want := range tests {
		var spec DashboardSpec
		if err := json.Unmarshal([]byte(base+body+`]}`), &spec); err != nil {
			t.Fatal(err)
		}
		if got := code(spec.Validate()); got != want {
			t.Errorf("%s\n  got %q, want %q", body, got, want)
		}
		if want == "" {
			optionsItem := spec.Filters[0].OptionsFrom
			if optionsItem == "" {
				optionsItem = spec.Filters[0].Targets[0].Item
			}
			if target, _ := spec.Filters[0].OptionsTarget(); target.Item != optionsItem {
				t.Errorf("OptionsTarget = %+v", target)
			}
		}
	}
}

func TestDashboardCheckFilters(t *testing.T) {
	users := &dataset.Spec{Fields: []dataset.Field{
		{Key: "uid", Label: "uid", Type: datasource.String, Role: dataset.Dimension},
		{Key: "level", Label: "level", Type: datasource.Integer, Role: dataset.Dimension},
		{Key: "day", Label: "day", Type: datasource.Date, Role: dataset.Dimension},
	}}
	a := chartSpec(t, `{"filters":[
		{"id":"region","field":"region","op":"in","label":"Region","control":{"type":"select","multi":true},"exposed":true},
		{"id":"when","field":"created","op":"time","label":"When","control":{"type":"relative"},"exposed":true},
		{"id":"name","field":"region","op":"contains","label":"Name","control":{"type":"text"},"exposed":true},
		{"id":"private","field":"region","op":"in","label":"Region","control":{"type":"select"}}]}`)
	b := chartSpec(t, `{"filters":[
		{"id":"uid","field":"uid","op":"in","label":"UID","control":{"type":"search_select","multi":true},"exposed":true},
		{"id":"level","field":"level","op":"in","label":"Level","control":{"type":"select"},"exposed":true},
		{"id":"day","field":"day","op":"time","label":"Day","control":{"type":"date_range"},"exposed":true}]}`)
	charts := func(id string) (*ChartSpec, *dataset.Spec, bool) {
		switch id {
		case "a":
			return a, orders, true
		case "b":
			return b, users, true
		}
		return nil, nil, false
	}
	const base = `{"specVersion":1,"layout":{"columns":12,"items":[{"id":"w1","type":"chart","chartId":"a","x":0,"y":0,"w":1,"h":1},{"id":"w2","type":"chart","chartId":"b","x":1,"y":0,"w":1,"h":1},{"id":"w3","type":"chart","chartId":"gone","x":2,"y":0,"w":1,"h":1}]},"filters":[`
	tests := map[string]string{
		// Two charts' filters under one name, on fields that are called differently.
		`{"id":"g","label":"用户","control":{"type":"search_select","multi":true},"targets":[{"item":"w1","filter":"region"},{"item":"w2","filter":"uid"}],"default":["u1"]}`: "",
		// A date and a timestamp can share a time range.
		`{"id":"g","label":"时间","control":{"type":"relative"},"targets":[{"item":"w1","filter":"when"},{"item":"w2","filter":"day"}],"default":{"current":"month"}}`: "",
		`{"id":"g","label":"x","control":{"type":"select"},"targets":[{"item":"w3","filter":"region"}]}`:                                                             "invalid_filter_target",
		`{"id":"g","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"nope"}]}`:                                                               "invalid_filter_target",
		`{"id":"g","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"private"}]}`:                                                            "",
		`{"id":"g","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"region"},{"item":"w2","filter":"level"}]}`:                              "filter_targets_differ",
		`{"id":"g","label":"x","control":{"type":"text"},"targets":[{"item":"w1","filter":"name"},{"item":"w2","filter":"uid"}]}`:                                    "filter_targets_differ",
		`{"id":"g","label":"x","control":{"type":"relative"},"targets":[{"item":"w1","filter":"region"}]}`:                                                           "invalid_filter_control",
		`{"id":"g","label":"x","control":{"type":"select"},"targets":[{"item":"w1","filter":"region"}],"default":["a","b"]}`:                                         "invalid_filter_value",
	}
	for body, want := range tests {
		var spec DashboardSpec
		if err := json.Unmarshal([]byte(base+body+`]}`), &spec); err != nil {
			t.Fatal(err)
		}
		if got := code(spec.Validate()); got != "" {
			t.Fatalf("%s\n  structure: %q", body, got)
		}
		if got := code(spec.CheckFilters(charts)); got != want {
			t.Errorf("%s\n  got %q, want %q", body, got, want)
		}
	}
}

func TestQueryContainerLayout(t *testing.T) {
	for _, tt := range []struct {
		name  string
		box   *QueryContainerLayout
		valid bool
	}{
		{"legacy", nil, true},
		{"placed", &QueryContainerLayout{X: 6, Y: 4, W: 6, H: 3}, true},
		{"outside", &QueryContainerLayout{X: 8, W: 6, H: 2}, false},
		{"negative", &QueryContainerLayout{Y: -1, W: 6, H: 2}, false},
		{"empty", &QueryContainerLayout{W: 0, H: 2}, false},
		{"fine grid maximum", &QueryContainerLayout{W: 12, H: 192}, true},
		{"too tall", &QueryContainerLayout{W: 12, H: 193}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			spec := DashboardSpec{SpecVersion: 1, Layout: Layout{Columns: 12}, QueryContainer: tt.box}
			if err := spec.Validate(); (err == nil) != tt.valid {
				t.Fatalf("Validate() = %v, valid = %v", err, tt.valid)
			}
			encoded, err := json.Marshal(spec)
			if err != nil {
				t.Fatal(err)
			}
			var decoded DashboardSpec
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if tt.box != nil && (decoded.QueryContainer == nil || *decoded.QueryContainer != *tt.box) {
				t.Fatalf("query container lost in round trip: %s", encoded)
			}
			if tt.box == nil && strings.Contains(string(encoded), "queryContainer") {
				t.Fatalf("legacy layout changed: %s", encoded)
			}
		})
	}
}

func TestSankeyFlows(t *testing.T) {
	spec := func(totals string) *ChartSpec {
		return chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","dimensions":[{"field":"region"},{"field":"created","grain":"month","alias":"month"},{"field":"amount"}],"measures":[{"field":"revenue","agg":"sum"}]`+totals+`},"viz":{"type":"sankey","levels":["region","month","amount"],"y":["revenue"]}}`)
	}
	// Three levels are two flows, each the database's total of a pair of neighbouring levels.
	if got := code(spec(`,"totals":[["month","region"],["month","amount"]]`).Validate(orders, dialect.Postgres{})); got != "" {
		t.Errorf("with both flows: %s", got)
	}
	if got := code(spec(`,"totals":[["region","month"]]`).Validate(orders, dialect.Postgres{})); got != "viz_sankey_needs_totals" {
		t.Errorf("without the second flow: %s", got)
	}
	if got := code(spec(``).Validate(orders, dialect.Postgres{})); got != "viz_sankey_unplaced" && got != "viz_sankey_needs_totals" {
		t.Errorf("without totals: %s", got)
	}
}

func TestColumnGroupsJSON(t *testing.T) {
	// An item is a column's alias or a group, and is written back the way it came.
	raw := `[{"label":"业绩","columns":[{"label":"金额","columns":["revenue"]},"orders"]}]`
	var groups []ColumnGroup
	if err := json.Unmarshal([]byte(raw), &groups); err != nil {
		t.Fatal(err)
	}
	if groups[0].Columns[0].Group.Label != "金额" || groups[0].Columns[1].Column != "orders" {
		t.Errorf("groups = %+v", groups)
	}
	if out, _ := json.Marshal(groups); string(out) != raw {
		t.Errorf("written back as %s", out)
	}
	// The request is read strictly as a whole; a group inside another is read on its own, as strictly.
	if err := json.Unmarshal([]byte(`[{"label":"a","columns":[{"label":"b","columns":["month"],"color":"red"}]}]`), &groups); err == nil {
		t.Error("a group with a property it does not have was read")
	}
}
