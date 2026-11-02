package api

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestDatasetParameterSettingsWorkflow(t *testing.T) {
	f := newContentFixture(t)
	original := f.developer.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	sourceID := original["datasourceId"].(string)
	spec := f.admin.spec(func(spec map[string]any) {
		spec["source"] = map[string]any{"type": "sql", "sql": fmt.Sprintf("SELECT * FROM %s.orders WHERE 1=1 [[ AND region IN {{regions}} ]]", f.admin.db.Schema)}
		spec["params"] = []any{map[string]any{"name": "regions", "type": "string", "label": "销售地区", "multi": true, "required": true, "default": []any{"华东"}}}
		fields := spec["fields"].([]any)
		fields[1].(map[string]any)["hidden"] = true
		// Hidden fields remain usable by calculated fields and existing charts.
		revenue := fields[3].(map[string]any)
		delete(revenue, "column")
		revenue["expr"], revenue["syntax"] = "${amount}", "standard"
	})

	// Exploration describes and runs the same parameterized SQL later saved as a dataset.
	f.developer.expect("POST", "/datasources/"+sourceID+"/describe", map[string]any{"source": spec["source"], "params": spec["params"]}, 200, "")
	preview := f.developer.expect("POST", "/datasets/preview", map[string]any{"datasourceId": sourceID, "spec": spec}, 200, "")
	if len(preview["rows"].([]any)) != 2 {
		t.Fatalf("default region must filter exploration: %v", preview)
	}
	created := f.developer.expect("POST", "/datasets", map[string]any{"name": "参数与字段配置", "datasourceId": sourceID, "spec": spec}, 201, "")
	f.datasetID = created["id"].(string)
	path := "/datasets/" + f.datasetID
	first := f.developer.expect("GET", path+"/revisions/1", nil, 200, "")
	loaded := f.developer.expect("GET", path, nil, 200, "")
	if !reflect.DeepEqual(loaded["spec"], first["spec"]) {
		t.Fatalf("saved settings and revision differ: %v, %v", loaded, first)
	}
	storedSpec := loaded["spec"].(map[string]any)
	param := storedSpec["params"].([]any)[0].(map[string]any)
	if param["label"] != "销售地区" || param["required"] != true || param["multi"] != true || storedSpec["fields"].([]any)[1].(map[string]any)["hidden"] != true {
		t.Fatalf("settings were not saved: %v", storedSpec)
	}

	chart := f.chart("区域销售", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"] = map[string]any{"version": 1, "dataset": f.datasetID, "dimensions": []any{map[string]any{"field": "region"}}, "measures": []any{map[string]any{"field": "revenue", "agg": "sum"}}}
	chartID := f.developer.expect("POST", "/charts", chart, 201, "")["id"].(string)
	boardID := f.developer.expect("POST", "/dashboards", map[string]any{"name": "区域销售仪表盘", "spec": dashboardSpec(chartID)}, 201, "")["id"].(string)
	dataPath := "/dashboards/" + boardID + "/items/wa/data"
	f.viewer.expect("POST", dataPath, nil, 404, "not_found")
	f.share(t, boardID)
	f.viewer.expect("GET", "/dashboards/"+boardID, nil, 200, "")
	checkRows := func(want string) {
		t.Helper()
		result := f.viewer.expect("POST", dataPath, nil, 200, "")
		rows, _ := json.Marshal(result["rows"])
		if string(rows) != want {
			t.Fatalf("viewer dashboard rows = %s, want %s", rows, want)
		}
	}
	checkRows(`[["华东","300.50"]]`)
	f.viewer.expect("GET", path, nil, 403, "forbidden")
	f.viewer.expect("GET", path+"/revisions/1", nil, 403, "forbidden")
	// An explicitly empty list does not use the default, and required still
	// applies when the placeholder occurs only inside an optional SQL block.
	query := map[string]any{"version": 1, "dataset": f.datasetID, "mode": "detail", "columns": []any{"region"}, "params": map[string]any{"regions": []any{}}}
	f.developer.expect("POST", "/query", map[string]any{"query": query}, 400, "missing_param")

	// Clearing the settings survives a save, changes live data, and leaves the
	// original snapshot available to restore through the ordinary save path.
	delete(param, "label")
	delete(param, "required")
	delete(param, "default")
	delete(storedSpec["fields"].([]any)[1].(map[string]any), "hidden")
	proposal := map[string]any{"name": created["name"], "datasourceId": sourceID, "spec": storedSpec, "expectedRevision": 1}
	changed := f.developer.expect("PUT", path, proposal, 200, "")
	f.developer.expect("POST", "/query", map[string]any{"query": query}, 200, "")
	checkRows(`[["华东","300.50"],["华南","300.25"]]`)
	proposal["spec"], proposal["expectedRevision"] = first["spec"], 2
	impact := f.developer.expect("POST", path+"/impact", proposal, 200, "")
	if len(impact["charts"].([]any)) != 1 {
		t.Fatalf("restoring required must report dependent charts: %v", impact)
	}
	proposal["impactToken"] = impact["confirmationToken"]
	restored := f.developer.expect("PUT", path, proposal, 200, "")
	if restored["revision"] != float64(3) || !reflect.DeepEqual(restored["spec"], first["spec"]) {
		t.Fatalf("restored settings = %v", restored)
	}
	second := f.developer.expect("GET", path+"/revisions/2", nil, 200, "")
	if !reflect.DeepEqual(second["spec"], changed["spec"]) {
		t.Fatalf("restore overwrote the intervening revision: %v", second)
	}
	checkRows(`[["华东","300.50"]]`)
	f.developer.expect("POST", "/query", map[string]any{"query": query}, 400, "missing_param")
}

func TestDatasetHistorySnapshotsPaginationAndAccess(t *testing.T) {
	f := newContentFixture(t)
	path := "/datasets/" + f.datasetID
	original := f.developer.expect("GET", path, nil, 200, "")
	first := f.developer.expect("GET", path+"/revisions/1", nil, 200, "")
	if first["name"] != original["name"] || first["datasourceId"] != original["datasourceId"] || first["datasourceName"] != "db" || first["createdByName"] != "Admin" || first["createdAt"] == nil || first["createdBy"] == nil || !reflect.DeepEqual(first["spec"], original["spec"]) {
		t.Fatalf("incomplete initial snapshot: %v", first)
	}
	other := f.admin.expect("POST", "/datasources", f.admin.datasourceInput("Replacement"), 201, "")
	for revision := 2; revision <= 4; revision++ {
		f.developer.expect("PUT", path, map[string]any{"name": fmt.Sprintf("Changed %d", revision), "description": "Changed description", "datasourceId": other["id"], "spec": original["spec"], "expectedRevision": revision - 1}, 200, "")
	}
	page := f.developer.expect("GET", path+"/revisions?limit=2", nil, 200, "")
	items := page["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["revision"] != float64(4) || items[1].(map[string]any)["revision"] != float64(3) || page["nextBefore"] != float64(3) || items[0].(map[string]any)["spec"] != nil {
		t.Fatalf("first page = %v", page)
	}
	page = f.developer.expect("GET", path+"/revisions?limit=2&before=3", nil, 200, "")
	items = page["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["revision"] != float64(2) || items[1].(map[string]any)["revision"] != float64(1) || page["nextBefore"] != nil {
		t.Fatalf("last page = %v", page)
	}
	latest := f.developer.expect("GET", path+"/revisions/4", nil, 200, "")
	if latest["name"] != "Changed 4" || latest["description"] != "Changed description" || latest["datasourceId"] != other["id"] || latest["datasourceName"] != "Replacement" || latest["createdByName"] != "developer" {
		t.Fatalf("changed snapshot = %v", latest)
	}
	// Historical data sources are names in the snapshot, not live references.
	f.admin.expect("DELETE", "/datasources/"+original["datasourceId"].(string), nil, 204, "")
	if again := f.developer.expect("GET", path+"/revisions/1", nil, 200, ""); !reflect.DeepEqual(again, first) {
		t.Fatalf("snapshot changed with the dataset or source: %v", again)
	}
	for _, suffix := range []string{"/revisions", "/revisions/1"} {
		f.viewer.expect("GET", path+suffix, nil, 403, "forbidden")
		f.admin.anonymous().expect("GET", path+suffix, nil, 401, "unauthenticated")
		f.admin.expect("GET", "/datasets/missing"+suffix, nil, 404, "not_found")
	}
	for _, suffix := range []string{"/revisions?limit=0", "/revisions?limit=101", "/revisions?before=0", "/revisions/0"} {
		f.admin.expect("GET", path+suffix, nil, 400, "invalid_request")
	}
	f.admin.expect("GET", path+"/revisions/99", nil, 404, "not_found")
	workspace := f.admin.expect("POST", "/workspaces", map[string]any{"name": "Other"}, 201, "")
	f.admin.expect("POST", "/auth/workspace", map[string]any{"workspaceId": workspace["id"]}, 200, "")
	f.admin.expect("GET", path+"/revisions", nil, 404, "not_found")
	f.admin.expect("GET", path+"/revisions/1", nil, 404, "not_found")
}

func TestRestoringDatasetSnapshotUsesNormalImpactAndConflictChecks(t *testing.T) {
	f := newContentFixture(t)
	path := "/datasets/" + f.datasetID
	first := f.developer.expect("GET", path+"/revisions/1", nil, 200, "")
	current := f.developer.expect("GET", path, nil, 200, "")
	spec := current["spec"].(map[string]any)
	spec["fields"] = append(spec["fields"].([]any), map[string]any{"key": "extra", "label": "Extra", "column": "amount", "type": "decimal", "role": "measure"})
	f.developer.expect("PUT", path, map[string]any{"name": "New definition", "description": "Changed", "datasourceId": current["datasourceId"], "spec": spec, "expectedRevision": 1}, 200, "")
	chart := f.chart("Uses new field", `{"type":"table"}`)
	chart["spec"].(map[string]any)["query"].(map[string]any)["measures"] = []any{map[string]any{"field": "extra", "agg": "sum"}}
	f.developer.expect("POST", "/charts", chart, 201, "")
	proposal := map[string]any{"name": first["name"], "description": first["description"], "datasourceId": first["datasourceId"], "spec": first["spec"], "expectedRevision": 1}
	f.developer.expect("PUT", path, proposal, 409, "resource_revision_conflict")
	proposal["expectedRevision"] = 2
	impact := f.developer.expect("POST", path+"/impact", proposal, 200, "")
	if len(impact["charts"].([]any)) != 1 {
		t.Fatalf("restoration must report the new chart: %v", impact)
	}
	f.developer.expect("PUT", path, proposal, 409, "dataset_impact_required")
	proposal["impactToken"] = impact["confirmationToken"]
	restored := f.developer.expect("PUT", path, proposal, 200, "")
	if restored["revision"] != float64(3) || restored["name"] != first["name"] || !reflect.DeepEqual(restored["spec"], first["spec"]) {
		t.Fatalf("restored dataset = %v", restored)
	}
	if old := f.developer.expect("GET", path+"/revisions/2", nil, 200, ""); old["name"] != "New definition" {
		t.Fatalf("restoration overwrote history: %v", old)
	}
	if old := f.developer.expect("GET", path+"/revisions/1", nil, 200, ""); !reflect.DeepEqual(old, first) {
		t.Fatalf("restoration overwrote the target snapshot: %v", old)
	}
}
