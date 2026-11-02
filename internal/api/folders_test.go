package api

import "testing"

func TestFolders(t *testing.T) {
	f := newContentFixture(t)
	folder := func(c *client, kind, name string, parent any) map[string]any {
		body := map[string]any{"kind": kind, "name": name}
		if parent != nil {
			body["parentId"] = parent
		}
		return body
	}

	f.developer.expect("POST", "/folders", folder(f.developer, "chart", " ", nil), 400, "name_required")
	f.developer.expect("POST", "/folders", folder(f.developer, "report", "x", nil), 400, "invalid_kind")
	sales := f.developer.expect("POST", "/folders", folder(f.developer, "chart", "销售", nil), 201, "")["id"].(string)
	inner := f.developer.expect("POST", "/folders", folder(f.developer, "chart", "华东", sales), 201, "")["id"].(string)
	// Names are unique among the folders next to each other, not across the tree.
	f.developer.expect("POST", "/folders", folder(f.developer, "chart", "销售", nil), 409, "name_taken")
	f.developer.expect("POST", "/folders", folder(f.developer, "chart", "销售", sales), 201, "")
	f.developer.expect("POST", "/folders", folder(f.developer, "dashboard", "销售", nil), 201, "")

	// Each kind has its own tree, and organising any of them is for developers.
	f.developer.expect("POST", "/folders", folder(f.developer, "dashboard", "x", sales), 404, "not_found")
	datasets := f.developer.expect("POST", "/folders", folder(f.developer, "dataset", "订单域", nil), 201, "")["id"].(string)
	f.viewer.expect("DELETE", "/folders/"+datasets, nil, 403, "forbidden")
	f.viewer.expect("POST", "/folders", folder(f.viewer, "chart", "x", nil), 403, "forbidden")
	// Viewers see the folders of what they can see, and not how datasets are organised.
	if _, list := f.developer.do("GET", "/folders", nil); len(list.([]any)) != 5 {
		t.Errorf("folders = %v", list)
	}
	_, list := f.viewer.do("GET", "/folders", nil)
	for _, item := range list.([]any) {
		if kind := item.(map[string]any)["kind"]; kind != "chart" && kind != "dashboard" {
			t.Errorf("a viewer sees a %s folder: %v", kind, item)
		}
	}
	if len(list.([]any)) != 4 {
		t.Errorf("folders a viewer sees = %v", list)
	}

	// A folder cannot be moved into itself or into what it holds.
	f.developer.expect("PUT", "/folders/"+sales, map[string]any{"name": "销售", "parentId": sales}, 400, "folder_cycle")
	f.developer.expect("PUT", "/folders/"+sales, map[string]any{"name": "销售", "parentId": inner}, 400, "folder_cycle")
	f.developer.expect("PUT", "/folders/"+inner, map[string]any{"name": "华东", "parentId": "fld_nope"}, 404, "not_found")
	moved := f.developer.expect("PUT", "/folders/"+inner, map[string]any{"name": "华东区"}, 200, "")
	if moved["name"] != "华东区" || moved["parentId"] != nil {
		t.Errorf("moved = %v", moved)
	}

	chart := f.developer.expect("POST", "/charts", f.chart("月度销售额", `{"type":"table"}`), 201, "")["id"].(string)
	move := func(kind, id string, to any) map[string]any {
		body := map[string]any{"kind": kind, "id": id}
		if to != nil {
			body["folderId"] = to
		}
		return body
	}
	f.developer.expect("POST", "/folders/move", move("chart", chart, sales), 204, "")
	f.developer.expect("POST", "/folders/move", move("chart", chart, datasets), 404, "not_found")
	f.developer.expect("POST", "/folders/move", move("chart", "ch_nope", sales), 404, "not_found")
	f.viewer.expect("POST", "/folders/move", move("dataset", f.datasetID, datasets), 403, "forbidden")
	f.developer.expect("POST", "/folders/move", move("dataset", f.datasetID, datasets), 204, "")
	_, charts := f.developer.do("GET", "/charts", nil)
	if got := charts.([]any)[0].(map[string]any)["folderId"]; got != sales {
		t.Errorf("chart folder = %v, want %v", got, sales)
	}
	// Saving a chart leaves it where it is.
	if saved := f.developer.editing("PUT", "/charts/"+chart, f.chart("月度销售额", `{"type":"table"}`), 200, ""); saved["folderId"] != sales {
		t.Errorf("saved = %v", saved)
	}

	// A folder is deleted empty.
	f.developer.expect("DELETE", "/folders/"+sales, nil, 409, "in_use")
	f.developer.expect("POST", "/folders/move", move("chart", chart, nil), 204, "")
	f.developer.expect("DELETE", "/folders/"+sales, nil, 409, "in_use") // still holds a folder
	f.developer.expect("DELETE", "/folders/fld_nope", nil, 404, "not_found")
}

func TestUsage(t *testing.T) {
	f := newContentFixture(t)
	chart := f.developer.expect("POST", "/charts", f.chart("月度销售额", `{"type":"table"}`), 201, "")["id"].(string)
	board := map[string]any{"name": "经营", "spec": map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": []any{
		map[string]any{"id": "a", "type": "chart", "chartId": chart, "x": 0, "y": 0, "w": 6, "h": 4},
	}}}}
	f.developer.expect("POST", "/dashboards", board, 201, "")

	names := func(list any) []string {
		var out []string
		for _, item := range list.([]any) {
			out = append(out, item.(map[string]any)["name"].(string))
		}
		return out
	}
	usage := f.developer.expect("GET", "/usage?kind=dataset&id="+f.datasetID, nil, 200, "")
	if c, d := names(usage["charts"]), names(usage["dashboards"]); len(c) != 1 || c[0] != "月度销售额" || len(d) != 1 || d[0] != "经营" {
		t.Errorf("dataset usage = %v", usage)
	}
	usage = f.developer.expect("GET", "/usage?kind=chart&id="+chart, nil, 200, "")
	if d := names(usage["dashboards"]); len(d) != 1 || d[0] != "经营" || len(usage["charts"].([]any)) != 0 {
		t.Errorf("chart usage = %v", usage)
	}
	f.developer.expect("GET", "/usage?kind=folder&id=x", nil, 400, "invalid_kind")
	f.viewer.expect("GET", "/usage?kind=chart&id="+chart, nil, 403, "forbidden")
}

func TestLineage(t *testing.T) {
	f := newContentFixture(t)
	chart := f.developer.expect("POST", "/charts", f.chart("月度销售额", `{"type":"table"}`), 201, "")["id"].(string)
	board := map[string]any{"name": "经营", "spec": map[string]any{"specVersion": 1, "layout": map[string]any{"columns": 12, "items": []any{
		map[string]any{"id": "a", "type": "chart", "chartId": chart, "x": 0, "y": 0, "w": 6, "h": 4},
	}}}}
	boardID := f.developer.expect("POST", "/dashboards", board, 201, "")["id"].(string)
	_, sources := f.admin.do("GET", "/datasources", nil)
	sourceID := sources.([]any)[0].(map[string]any)["id"].(string)
	orders := f.admin.db.Schema + ".orders"
	tableID := "table:" + sourceID + ":" + orders
	detail := f.admin.expect("POST", "/datasets", map[string]any{"name": "明细", "datasourceId": sourceID, "spec": f.admin.spec(nil)}, 201, "")["id"].(string)
	// What names no table stays tied to the data source itself.
	bare := f.admin.expect("POST", "/datasets", map[string]any{"name": "常量", "datasourceId": sourceID, "spec": map[string]any{
		"specVersion": 1, "source": map[string]any{"type": "sql", "sql": "SELECT 1 AS n"},
		"fields": []any{map[string]any{"key": "n", "label": "n", "column": "n", "type": "integer", "role": "dimension"}},
	}}, 201, "")["id"].(string)

	read := func(c *client) (map[string]map[string]any, map[string]bool) {
		t.Helper()
		lineage := c.expect("GET", "/lineage", nil, 200, "")
		nodes := map[string]map[string]any{}
		for _, n := range lineage["nodes"].([]any) {
			node := n.(map[string]any)
			nodes[node["id"].(string)] = node
		}
		edges := map[string]bool{}
		for _, e := range lineage["edges"].([]any) {
			edge := e.(map[string]any)
			edges[edge["from"].(string)+">"+edge["to"].(string)] = true
		}
		return nodes, edges
	}

	nodes, edges := read(f.admin)
	if len(nodes) != 7 || nodes[sourceID]["kind"] != "datasource" || nodes[sourceID]["sourceType"] == nil || nodes[detail]["name"] != "明细" || nodes[boardID]["kind"] != "dashboard" {
		t.Errorf("nodes = %v", nodes)
	}
	if nodes[tableID]["kind"] != "table" || nodes[tableID]["name"] != orders {
		t.Errorf("table = %v in %v", nodes[tableID], nodes)
	}
	want := []string{sourceID + ">" + tableID, tableID + ">" + f.datasetID, tableID + ">" + detail, sourceID + ">" + bare, f.datasetID + ">" + chart, chart + ">" + boardID}
	for _, edge := range want {
		if !edges[edge] {
			t.Errorf("missing edge %s in %v", edge, edges)
		}
	}
	if edges[sourceID+">"+f.datasetID] || edges[sourceID+">"+detail] {
		t.Errorf("what reads a table is still tied to the data source itself: %v", edges)
	}

	// Every developer sees all of it, by name; viewers see none of it.
	nodes, _ = read(f.developer)
	if len(nodes) != 7 || nodes[sourceID]["name"] != "db" || nodes[detail]["name"] != "明细" {
		t.Errorf("developer's nodes = %v", nodes)
	}
	f.viewer.expect("GET", "/lineage", nil, 403, "forbidden")
}
