package content

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/query"
)

// snapshots reads one day's snapshot, which the SQL cannot do without, and
// may narrow it down further.
var snapshots = &dataset.Spec{
	SpecVersion: 1,
	Source:      dataset.Source{Type: "sql", SQL: "SELECT * FROM orders WHERE dt = {{day}} [[ AND region IN {{regions}} ]] [[ AND paid = {{paid}} ]] [[ AND qty >= {{qty}} ]]"},
	Params: []dataset.Param{
		{Name: "day", Type: datasource.Date, Default: map[string]any{"relative": "today-1d"}},
		{Name: "regions", Type: datasource.String, Multi: true, Default: []any{"east", "south"}},
		{Name: "paid", Type: datasource.Boolean},
		{Name: "qty", Type: datasource.Integer, Required: true, Default: float64(1)},
	},
	Fields: []dataset.Field{
		{Key: "region", Label: "region", Column: "region", Type: datasource.String, Role: dataset.Dimension},
		{Key: "amount", Label: "amount", Column: "amount", Type: datasource.Decimal, Role: dataset.MeasureRole},
	},
}

const snapshotChart = `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"}]},"viz":{"type":"kpi","y":["amount"]},"filters":[`

func TestParamFilterValidate(t *testing.T) {
	tests := map[string]string{
		`{"id":"p","param":"day","value":"2026-01-01"}`:                                                                    "",
		`{"id":"p","param":"day","value":{"relative":"today"}}`:                                                            "",
		`{"id":"p","param":"day","label":"Day","control":{"type":"input"}}`:                                                "",
		`{"id":"p","param":"regions","label":"R","control":{"type":"select"},"options":["north"]}`:                         "",
		`{"id":"p","param":"regions","label":"R","control":{"type":"select"},"options":["east","north"],"value":["east"]}`: "",
		`{"id":"p","param":"regions","label":"R","control":{"type":"select"},"options":["east"],"value":[]}`:               "",
		`{"id":"p","param":"paid","label":"Paid","control":{"type":"select"},"value":null}`:                                "",
		`{"id":"p","param":"nope","value":1}`:                                                                              "unknown_param",
		`{"id":"p","param":"day","field":"region","value":"2026-01-01"}`:                                                   "invalid_filter",
		`{"id":"p","param":"day","op":"eq","value":"2026-01-01"}`:                                                          "invalid_filter",
		`{"id":"p","param":"day","label":"Day","control":{"type":"input"},"dependsOn":["q"]}`:                              "invalid_filter",
		`{"id":"p","param":"day","value":"2026-01-01"},{"id":"q","param":"day","value":"2026-01-02"}`:                      "duplicate_param_filter",
		`{"id":"p","param":"day"}`:                                                                                  "filter_needs_value",
		`{"id":"p","param":"regions","value":[]}`:                                                                   "filter_needs_value",
		`{"id":"p","param":"day","value":"soon"}`:                                                                   "invalid_param_value",
		`{"id":"p","param":"regions","value":"east"}`:                                                               "invalid_param_value",
		`{"id":"p","param":"qty","value":[1]}`:                                                                      "invalid_param_value",
		`{"id":"p","param":"qty","value":{"relative":"today"}}`:                                                     "invalid_param_value",
		`{"id":"p","param":"qty","control":{"type":"input"}}`:                                                       "filter_needs_label",
		`{"id":"p","param":"paid","label":"Paid","control":{"type":"input"}}`:                                       "invalid_filter_control",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"select","multi":true}}`:                             "invalid_filter_control",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"search_select"}}`:                                   "invalid_filter_control",
		`{"id":"p","param":"paid","label":"Paid","control":{"type":"select"},"options":[true]}`:                     "invalid_param_options",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"input"},"options":[2]}`:                             "invalid_param_options",
		`{"id":"p","param":"qty","value":2,"options":[2]}`:                                                          "invalid_param_options",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"select"},"options":[2,2]}`:                          "invalid_param_options",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"select"},"options":[[2]]}`:                          "invalid_param_options",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"select"},"options":["two"]}`:                        "invalid_param_value",
		`{"id":"p","param":"regions","label":"R","control":{"type":"select"},"options":["north"],"value":["east"]}`: "invalid_param_value",
		`{"id":"p","param":"qty","label":"Q","control":{"type":"input"},"value":null}`:                              "param_needs_default",
		`{"id":"p","param":"day","label":"Day","control":{"type":"select"},"options":["2026-01-01"],"value":null}`:  "param_needs_default",
	}
	for body, want := range tests {
		spec := chartSpec(t, snapshotChart+body+`]}`)
		if got := code(spec.Validate(snapshots, dialect.Postgres{})); got != want {
			t.Errorf("%s\n  got %q, want %q", body, got, want)
		}
	}
	// A parameter the query fixes has no filter besides.
	fixed := chartSpec(t, `{"specVersion":1,"query":{"version":1,"dataset":"d","measures":[{"field":"amount","agg":"sum"}],"params":{"day":"2026-01-01"}},"viz":{"type":"kpi","y":["amount"]},
		"filters":[{"id":"p","param":"day","label":"Day","control":{"type":"input"}}]}`)
	if got := code(fixed.Validate(snapshots, dialect.Postgres{})); got != "duplicate_param_filter" {
		t.Errorf("a parameter fixed in the query and filtered: got %q", got)
	}
}

// Written as null, a parameter filter's value gives the parameter none; left
// out, the parameter keeps the dataset's default. Saving keeps the two apart.
func TestParamFilterValueNullOrLeftOut(t *testing.T) {
	for body, wantSet := range map[string]bool{
		`{"id":"p","param":"regions","value":null}`: true,
		`{"id":"p","param":"regions"}`:              false,
	} {
		var f ChartFilter
		if err := json.Unmarshal([]byte(body), &f); err != nil {
			t.Fatal(err)
		}
		if f.ValueSet != wantSet || f.Value != nil {
			t.Errorf("%s read as %+v", body, f)
		}
		written, err := json.Marshal(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(written), `"value":null`) != wantSet {
			t.Errorf("%s written as %s", body, written)
		}
	}
	// A field filter's null value is no value, as it always was.
	written, _ := json.Marshal(ChartFilter{ID: "f", Field: "region", Op: "in", ValueSet: true})
	if strings.Contains(string(written), "value") {
		t.Errorf("a field filter's empty value was written: %s", written)
	}
	var f ChartFilter
	if err := json.Unmarshal([]byte(`{"id":"p","param":"day","valu":1}`), &f); err == nil {
		t.Error("a misspelt key was read")
	}
}

func TestParamFilterValuesForViewers(t *testing.T) {
	spec := chartSpec(t, snapshotChart+`
		{"id":"p_day","param":"day","label":"Day","control":{"type":"input"}},
		{"id":"p_regions","param":"regions","label":"Regions","control":{"type":"select"},"options":["north"]},
		{"id":"p_qty","param":"qty","value":5}]}`)
	if err := spec.Validate(snapshots, dialect.Postgres{}); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name   string
		values map[string]any
		want   map[string]any
		code   string
	}{
		{"defaults", nil, map[string]any{"qty": float64(5)}, ""},
		{"chosen", map[string]any{"p_day": "2026-01-02", "p_regions": []any{"north", "east"}}, map[string]any{"day": "2026-01-02", "regions": []any{"north", "east"}, "qty": float64(5)}, ""},
		{"none", map[string]any{"p_regions": []any{}}, map[string]any{"regions": []any{}, "qty": float64(5)}, ""},
		// The default as it stands can be sent back, relative or not.
		{"default sent back", map[string]any{"p_day": map[string]any{"relative": "today-1d"}}, map[string]any{"day": map[string]any{"relative": "today-1d"}, "qty": float64(5)}, ""},
		{"not offered", map[string]any{"p_regions": []any{"west"}}, nil, "invalid_param_value"},
		{"relative day typed in", map[string]any{"p_day": map[string]any{"relative": "today"}}, nil, "invalid_param_value"},
		{"wrong type", map[string]any{"p_day": "tomorrow"}, nil, "invalid_param_value"},
		{"one for several", map[string]any{"p_regions": "north"}, nil, "invalid_param_value"},
		{"fixed", map[string]any{"p_qty": float64(3)}, nil, "filter_not_interactive"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			q, err := spec.ForViewer(tt.values, snapshots)
			if code(err) != tt.code {
				t.Fatalf("got %v, want %q", err, tt.code)
			}
			if tt.code == "" && !reflect.DeepEqual(q.Params, tt.want) {
				t.Fatalf("params = %v, want %v", q.Params, tt.want)
			}
		})
	}
	if spec.Query.Params != nil {
		t.Fatalf("viewers changed the chart's query: %v", spec.Query.Params)
	}
	// The SQL cannot do without the day, so a viewer cannot clear it.
	q, err := spec.ForViewer(map[string]any{"p_day": nil}, snapshots)
	if err == nil {
		_, err = query.Compile(&q, snapshots, query.Options{Dialect: dialect.Postgres{}, Now: time.Now(), DefaultLimit: 10, MaxLimit: 10})
	}
	if code(err) != "missing_param" {
		t.Fatalf("a day cleared: %v", err)
	}
}

func TestParamControls(t *testing.T) {
	spec := chartSpec(t, snapshotChart+`
		{"id":"p_day","param":"day","label":"Day","control":{"type":"input"}},
		{"id":"p_regions","param":"regions","label":"Regions","control":{"type":"select"},"options":["north","south"]},
		{"id":"p_paid","param":"paid","label":"Paid","control":{"type":"select"}},
		{"id":"p_qty","param":"qty","value":5}]}`)
	got := spec.ParamControls(snapshots)
	want := map[string]ParamControl{
		"p_day": {Type: datasource.Date, NeedsValue: true, Default: map[string]any{"relative": "today-1d"}},
		// The dataset's default leads, where the author's options leave out part of it.
		"p_regions": {Type: datasource.String, Multi: true, Default: []any{"east", "south"}, Options: []any{"east", "north", "south"}},
		"p_paid":    {Type: datasource.Boolean, Options: []any{true, false}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("controls = %+v\nwant %+v", got, want)
	}
}

// Options for a field filter come from the data as the parameters shape it.
func TestFieldOptionsKeepParamValues(t *testing.T) {
	spec := chartSpec(t, snapshotChart+`
		{"id":"region","field":"region","op":"in","label":"Region","control":{"type":"select"}},
		{"id":"p_day","param":"day","label":"Day","control":{"type":"input"}}]}`)
	q, field, err := spec.OptionsQuery("region", map[string]any{"p_day": "2026-01-02", "region": []any{"east"}}, snapshots, false)
	if err != nil || field != "region" {
		t.Fatal(field, err)
	}
	if q.Params["day"] != "2026-01-02" {
		t.Fatalf("options read %v", q.Params)
	}
	if _, _, err := spec.OptionsQuery("p_day", nil, snapshots, false); code(err) != "invalid_filter_options" {
		t.Fatalf("options of a parameter: %v", err)
	}
}

func TestDashboardKeepsParamValues(t *testing.T) {
	spec := chartSpec(t, snapshotChart+`
		{"id":"region","field":"region","op":"in","label":"Region","control":{"type":"select"}},
		{"id":"p_day","param":"day","label":"Day","control":{"type":"input"}}]}`)
	item := Item{ID: "w1", ChartID: "c"}
	dash := DashboardSpec{Filters: []Filter{{ID: "global", Op: "in", Control: Control{Type: ControlSelect}, Targets: []FilterTarget{{Item: "w1", Field: "region"}}}}}
	for _, useChartFilters := range []bool{false, true} {
		q, err := dash.QueryForViewer(item, spec, snapshots, nil, map[string]any{"p_day": "2026-01-02"}, useChartFilters)
		if err != nil || q.Params["day"] != "2026-01-02" {
			t.Fatalf("using chart filters %v: %v, %v", useChartFilters, q.Params, err)
		}
	}
	overridden, err := dash.OverriddenFilters(item, spec, snapshots)
	if err != nil || !reflect.DeepEqual(overridden, []string{"region"}) {
		t.Fatalf("overridden %v, %v", overridden, err)
	}
	// A global filter binds fields; a parameter filter is none.
	bound := DashboardSpec{Filters: []Filter{{ID: "global", Op: "eq", Control: Control{Type: ControlDate}, Targets: []FilterTarget{{Item: "w1", Filter: "p_day"}}}}}
	if _, err := bound.QueryForViewer(item, spec, snapshots, nil, nil, false); code(err) != "invalid_filter_target" {
		t.Fatalf("a global filter on a parameter: %v", err)
	}
}
