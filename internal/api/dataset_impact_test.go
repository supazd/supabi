package api

import (
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

func TestDatasetImpactParametersThatBecomeRequiredBySQL(t *testing.T) {
	for _, change := range []string{"remove default", "new placeholder", "leave optional block"} {
		t.Run(change, func(t *testing.T) {
			f := newContentFixture(t)
			current := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
			spec := current["spec"].(map[string]any)
			param := spec["params"].([]any)[0].(map[string]any)
			param["required"] = false
			baseSQL := fmt.Sprintf("SELECT * FROM %s.orders", f.admin.db.Schema)
			switch change {
			case "new placeholder":
				spec["source"] = map[string]any{"type": "sql", "sql": baseSQL}
				delete(spec, "params")
			case "leave optional block":
				spec["source"] = map[string]any{"type": "sql", "sql": baseSQL + " [[ WHERE order_date >= {{since}} ]]"}
				delete(param, "default")
			}
			input := map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": spec}
			current = f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
			input["expectedRevision"] = current["revision"]
			chartID := f.developer.expect("POST", "/charts", f.chart("Sales", `{"type":"table"}`), 201, "")["id"].(string)
			boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Overview", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
			f.developer.expect("POST", "/charts/"+chartID+"/data", nil, 200, "")

			delete(param, "default")
			spec["params"] = []any{param}
			spec["source"] = map[string]any{"type": "sql", "sql": baseSQL + " WHERE order_date >= {{since}}"}
			impact := f.developer.editing("POST", "/datasets/"+f.datasetID+"/impact", input, 200, "")
			changes := impact["changes"].([]any)
			if len(changes) != 1 || changes[0].(map[string]any)["key"] != "since" || changes[0].(map[string]any)["reason"] != "required" {
				t.Fatalf("missing required SQL parameter impact: %v", impact)
			}
			if charts := impact["charts"].([]any); len(charts) != 1 || charts[0].(map[string]any)["id"] != chartID {
				t.Fatalf("affected charts: %v", charts)
			}
			if boards := impact["dashboards"].([]any); len(boards) != 1 || boards[0].(map[string]any)["id"] != boardID {
				t.Fatalf("affected dashboards: %v", boards)
			}
			f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 409, "dataset_impact_required")
			f.developer.expect("POST", "/charts/"+chartID+"/data", nil, 200, "")
			input["impactToken"] = impact["confirmationToken"]
			f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
			f.developer.expect("POST", "/charts/"+chartID+"/data", nil, 400, "missing_param")
		})
	}
}

func TestDatasetImpactRequiredMultivalueWithDefault(t *testing.T) {
	for _, change := range []string{"required flag", "leave optional block"} {
		t.Run(change, func(t *testing.T) {
			f := newContentFixture(t)
			current := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
			spec := current["spec"].(map[string]any)
			baseSQL := fmt.Sprintf("SELECT * FROM %s.orders", f.admin.db.Schema)
			spec["source"] = map[string]any{"type": "sql", "sql": baseSQL + " [[ WHERE order_date IN {{since}} ]]"}
			param := map[string]any{"name": "since", "type": "date", "multi": true, "default": []any{"2026-01-01"}}
			spec["params"] = []any{param}
			input := map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": spec}
			f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
			chart := f.chart("All dates", `{"type":"table"}`)
			chart["spec"].(map[string]any)["query"].(map[string]any)["params"] = map[string]any{"since": []any{}}
			chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
			f.developer.expect("POST", "/charts/"+chartID+"/data", nil, 200, "")
			if change == "required flag" {
				param["required"] = true
			} else {
				spec["source"] = map[string]any{"type": "sql", "sql": baseSQL + " WHERE order_date IN {{since}}"}
			}
			impact := f.developer.editing("POST", "/datasets/"+f.datasetID+"/impact", input, 200, "")
			if charts := impact["charts"].([]any); len(charts) != 1 || charts[0].(map[string]any)["id"] != chartID {
				t.Fatalf("empty multi-value override was not affected: %v", impact)
			}
			f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 409, "dataset_impact_required")
			input["impactToken"] = impact["confirmationToken"]
			f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
			f.developer.expect("POST", "/charts/"+chartID+"/data", nil, 400, "missing_param")
		})
	}
}

func TestDatasetImpactSaveConfirmation(t *testing.T) {
	f := newContentFixture(t)
	chartInput := f.chart("Sales", `{"type":"table"}`)
	chartID := f.developer.expect("POST", "/charts", chartInput, 201, "")["id"].(string)
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Overview", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	current := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	input := map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": current["spec"], "expectedRevision": current["revision"]}
	fields := input["spec"].(map[string]any)["fields"].([]any)
	fields[3].(map[string]any)["label"] = "Revenue renamed"
	impactPath := "/datasets/" + f.datasetID + "/impact"
	impact := f.developer.expect("POST", impactPath, input, 200, "")
	if len(impact["changes"].([]any)) != 0 || len(impact["charts"].([]any)) != 0 {
		t.Fatalf("label edit has impact: %v", impact)
	}
	input["spec"].(map[string]any)["fields"] = fields[:3]
	impact = f.developer.expect("POST", impactPath, input, 200, "")
	changes := impact["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["label"] != "销售额" || changes[0].(map[string]any)["reason"] != "removed" {
		t.Fatalf("changes: %v", changes)
	}
	if hits := impact["charts"].([]any); len(hits) != 1 || hits[0].(map[string]any)["id"] != chartID {
		t.Fatalf("charts: %v", hits)
	}
	if hits := impact["dashboards"].([]any); len(hits) != 1 || hits[0].(map[string]any)["id"] != boardID {
		t.Fatalf("boards: %v", hits)
	}
	f.viewer.expect("POST", impactPath, input, 403, "forbidden")
	f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 409, "dataset_impact_required")
	unchanged := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	if unchanged["revision"] != current["revision"] {
		t.Fatal("unconfirmed save wrote a revision")
	}
	input["impactToken"] = impact["confirmationToken"]
	// Fixing or editing a reader in the other tab makes the old review stale.
	chartInput["name"] = "Sales edited"
	f.developer.editing("PUT", "/charts/"+chartID, chartInput, 200, "")
	f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 409, "dataset_impact_required")
	impact = f.developer.expect("POST", impactPath, input, 200, "")
	input["impactToken"] = impact["confirmationToken"]
	saved := f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
	if saved["revision"].(float64) != current["revision"].(float64)+1 {
		t.Fatalf("saved: %v", saved)
	}
	f.developer.expect("POST", impactPath, input, 409, "resource_revision_conflict")
	f.developer.editing("PUT", "/datasets/"+f.datasetID, input, 409, "resource_revision_conflict")
}

func TestDatasetImpactDashboardOnlyField(t *testing.T) {
	f := newContentFixture(t)
	chartID := f.developer.expect("POST", "/charts", f.chart("Sales", `{"type":"table"}`), 201, "")["id"].(string)
	plain := f.developer.expect("POST", "/dashboards", map[string]any{"name": "No amount binding", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	spec := dashboardSpec(chartID)
	spec["filters"] = []any{map[string]any{"id": "amount_filter", "label": "Amount", "op": "gte", "control": map[string]any{"type": "number"}, "default": 10, "targets": []any{map[string]any{"item": "wa", "field": "amount"}}}}
	filtered := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Amount binding", "spec": spec}, 201, "")["id"].(string)
	current := f.admin.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	fields := current["spec"].(map[string]any)["fields"].([]any)
	current["spec"].(map[string]any)["fields"] = []any{fields[0], fields[2], fields[3]}
	input := map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": current["spec"]}
	impact := f.admin.editing("POST", "/datasets/"+f.datasetID+"/impact", input, 200, "")
	boards := impact["dashboards"].([]any)
	if len(boards) != 1 || boards[0].(map[string]any)["id"] != filtered {
		t.Fatalf("dashboard-only reference lost or leaked to %s: %v", plain, impact)
	}
	if len(impact["charts"].([]any)) != 1 {
		t.Fatalf("expected containing chart: %v", impact)
	}
	input["impactToken"] = impact["confirmationToken"]
	f.admin.editing("PUT", "/datasets/"+f.datasetID, input, 200, "")
}

func TestDatasetChangesAndReferenceCoverage(t *testing.T) {
	old := dataset.Spec{Source: dataset.Source{Type: "sql", SQL: "SELECT 1"}, Fields: []dataset.Field{
		{Key: "base", Label: "Base", Type: datasource.Decimal, Role: dataset.MeasureRole},
		{Key: "metric", Expr: "sum(${base})", Type: datasource.Decimal, Role: dataset.Metric},
		{Key: "unused", Label: "Unused", Type: datasource.String, Role: dataset.Dimension},
	}, Params: []dataset.Param{{Name: "p", Type: datasource.String}, {Name: "gone", Type: datasource.String}}}
	next := old
	next.Fields = slices.Clone(old.Fields)
	next.Params = []dataset.Param{{Name: "p", Type: datasource.Integer, Required: true, Multi: true}, {Name: "new", Required: true}}
	next.Fields[0].Type = datasource.Float
	next.Fields[0].Role = dataset.Dimension
	next.Fields = next.Fields[:2]
	changes := datasetChanges(&old, &next)
	if len(changes) != 8 {
		t.Fatalf("destructive changes: %v", changes)
	}
	cases := map[string]content.ChartSpec{
		"detail":                {Query: query.Query{Columns: []query.DetailColumn{{Field: "base"}}}},
		"expression dependency": {Query: query.Query{Measures: []query.Measure{{Field: "metric"}}}},
		"nested filter":         {Query: query.Query{Filter: &dataset.Filter{Op: "and", Args: []dataset.Filter{{Op: "eq", Field: "base"}}}}},
		"having measure":        {Query: query.Query{FilterMeasures: []query.Measure{{Field: "base", Alias: "total"}}, Having: &dataset.Filter{Field: "total"}}},
		"comparison":            {Query: query.Query{Measures: []query.Measure{{Field: "other", Compute: &query.Compute{TimeField: "base"}}}}},
		"dynamic unselected":    {Dynamics: []content.DynamicField{{Options: []content.DynamicOption{{Field: "other"}, {Field: "base"}}}}},
		"drill levels":          {Drill: &content.Drill{Levels: []content.DrillLevel{{Field: "other"}, {Field: "base"}}}},
		"local filter":          {Filters: []content.ChartFilter{{Field: "base"}}},
	}
	for name, chart := range cases {
		t.Run(name, func(t *testing.T) {
			refs := chartFieldRefs(&chart)
			hit := affectedChanges(changes, refs, chartParamRefs(&chart), &old, &next)
			// Base's type and role, and the parameters coming to need a
			// value; not the changes to parameters the chart gives none.
			if !slices.Equal(hit, []int{0, 1, 5, 7}) {
				t.Fatalf("impact indexes %v for %v", hit, changes)
			}
		})
	}
	// Removing a parameter or changing its type touches the charts giving it
	// a value, through a parameter filter or fixed in the query.
	gives := content.ChartSpec{Query: query.Query{Params: map[string]any{"gone": "x"}}, Filters: []content.ChartFilter{{ID: "p_p", Param: "p"}}}
	if hit := affectedChanges(changes, chartFieldRefs(&gives), chartParamRefs(&gives), &old, &next); !slices.Equal(hit, []int{3, 4, 5, 6, 7}) {
		t.Fatalf("impact indexes %v for parameters given values, of %v", hit, changes)
	}
	// Defaults, labels and mapping changes alone are not destructive.
	same := old
	same.Fields = slices.Clone(old.Fields)
	same.Fields[0].Label = "Renamed"
	same.Fields[0].Column = "other"
	same.Params = slices.Clone(old.Params)
	same.Params[0].Default = "x"
	if got := datasetChanges(&old, &same); len(got) != 0 {
		t.Fatalf("safe edit flagged: %v", got)
	}
	// A required parameter used to work without an explicit value while its
	// default existed. Removing that default also needs a review.
	withDefault := dataset.Spec{Source: old.Source, Params: []dataset.Param{{Name: "since", Required: true, Default: "2026-01-01"}}}
	withoutDefault := dataset.Spec{Source: old.Source, Params: []dataset.Param{{Name: "since", Required: true}}}
	if got := datasetChanges(&withDefault, &withoutDefault); len(got) != 1 || got[0].Reason != "required" {
		t.Fatalf("removed required default not detected: %v", got)
	}
}

func TestDatasetChangesEffectiveParameterRequirements(t *testing.T) {
	const optional = "SELECT 1 [[ WHERE 1 = {{p}} ]]"
	for _, tt := range []struct {
		name          string
		beforeSQL     string
		afterSQL      string
		before, after []dataset.Param
		want          []string
	}{
		{name: "replace a valid default", beforeSQL: "SELECT {{p}}", afterSQL: "SELECT {{p}}", before: []dataset.Param{{Name: "p", Default: 1}}, after: []dataset.Param{{Name: "p", Default: 2}}},
		{name: "clear optional default", beforeSQL: optional, afterSQL: optional, before: []dataset.Param{{Name: "p", Default: 1}}, after: []dataset.Param{{Name: "p"}}},
		{name: "new required placeholder with default", beforeSQL: "SELECT 1", afterSQL: "SELECT {{p}}", after: []dataset.Param{{Name: "p", Default: 1}}},
		{name: "new required flag with default", beforeSQL: "SELECT 1", afterSQL: "SELECT {{p}}", after: []dataset.Param{{Name: "p", Required: true, Default: 1}}},
		// A viewer may have cleared the parameter's control, which bypasses the default.
		{name: "required flag with retained default", beforeSQL: optional, afterSQL: optional, before: []dataset.Param{{Name: "p", Default: 1}}, after: []dataset.Param{{Name: "p", Required: true, Default: 1}}, want: []string{"p"}},
		{name: "leave optional block with default", beforeSQL: optional, afterSQL: "SELECT {{p}}", before: []dataset.Param{{Name: "p", Default: 1}}, after: []dataset.Param{{Name: "p", Default: 1}}, want: []string{"p"}},
		{name: "quoted and commented placeholders", beforeSQL: "SELECT 1", afterSQL: "SELECT '{{p}}' /* {{p}} */ -- {{p}}", after: []dataset.Param{{Name: "p"}}},
		{name: "empty multivalue default", beforeSQL: "SELECT 1 WHERE 1 IN {{p}}", afterSQL: "SELECT 1 WHERE 1 IN {{p}}", before: []dataset.Param{{Name: "p", Multi: true, Default: []any{1}}}, after: []dataset.Param{{Name: "p", Multi: true, Default: []any{}}}, want: []string{"p"}},
		{name: "several new missing values", beforeSQL: "SELECT 1", afterSQL: "SELECT {{p}}, {{q}} [[ WHERE 1 = {{r}} ]]", after: []dataset.Param{{Name: "p"}, {Name: "q"}, {Name: "r"}}, want: []string{"p", "q"}},
		{name: "one optional and one required use", beforeSQL: optional, afterSQL: "SELECT {{p}} [[ WHERE 1 = {{p}} ]]", before: []dataset.Param{{Name: "p"}}, after: []dataset.Param{{Name: "p"}}, want: []string{"p"}},
		{name: "already requires input", beforeSQL: "SELECT {{p}}", afterSQL: "SELECT {{p}}", before: []dataset.Param{{Name: "p"}}, after: []dataset.Param{{Name: "p", Required: true}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			old := dataset.Spec{Source: dataset.Source{Type: "sql", SQL: tt.beforeSQL}, Params: tt.before}
			next := dataset.Spec{Source: dataset.Source{Type: "sql", SQL: tt.afterSQL}, Params: tt.after}
			var got []string
			for _, change := range datasetChanges(&old, &next) {
				if change.Kind != "parameter" || change.Reason != "required" {
					t.Fatalf("unexpected change: %v", change)
				}
				got = append(got, change.Key)
			}
			if !slices.Equal(got, tt.want) {
				t.Fatalf("parameters newly requiring input = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDatasetImpactTokensBindProposal(t *testing.T) {
	old := dataset.Spec{Fields: []dataset.Field{{Key: "a", Label: "A", Type: datasource.String, Role: dataset.Dimension}}}
	raw, _ := json.Marshal(old)
	current := store.Dataset{ID: "ds_one", Revision: 1, Spec: raw}
	input := &gen.DatasetInput{Name: "one", DatasourceId: "source", Spec: map[string]any{}}
	first, err := analyzeDatasetImpact(current, input, &old, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	input.Name = "two"
	second, err := analyzeDatasetImpact(current, input, &old, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if first.ConfirmationToken == second.ConfirmationToken {
		t.Fatal("token not bound to proposal")
	}
}
