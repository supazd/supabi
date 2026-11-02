package api

import (
	"maps"
	"reflect"
	"testing"
)

func TestContentSaveProtocol(t *testing.T) {
	f := newContentFixture(t)
	chart := f.developer.expect("POST", "/charts", f.chart("Chart", `{"type":"table"}`), 201, "")
	board := f.developer.expect("POST", "/dashboards", map[string]any{"name": "Board", "spec": dashboardSpec(chart["id"].(string))}, 201, "")
	for _, path := range []string{"/datasets/" + f.datasetID, "/charts/" + chart["id"].(string), "/dashboards/" + board["id"].(string)} {
		t.Run(path, func(t *testing.T) {
			original := f.developer.expect("GET", path, nil, 200, "")
			input := map[string]any{"name": original["name"], "description": original["description"], "spec": original["spec"]}
			if source, ok := original["datasourceId"]; ok {
				input["datasourceId"] = source
			}
			f.developer.expect("PUT", path, input, 400, "revision_required")
			for _, bad := range []any{nil, 0, -1} {
				input["expectedRevision"] = bad
				f.developer.expect("PUT", path, input, 400, "revision_required")
			}
			input["expectedRevision"] = original["revision"]
			first := maps.Clone(input)
			first["name"] = "Changed " + original["name"].(string)
			saved := f.developer.expect("PUT", path, first, 200, "")
			if saved["revision"] != original["revision"].(float64)+1 {
				t.Fatalf("revision did not advance: %v", saved)
			}
			input["description"] = "Second editor's draft"
			f.developer.expect("PUT", path, input, 409, "resource_revision_conflict")
			// Even a stale definition invalidated by newer edits opens the
			// conflict workflow before normal definition validation.
			invalid := maps.Clone(input)
			invalid["spec"] = map[string]any{}
			f.developer.expect("PUT", path, invalid, 409, "resource_revision_conflict")
			if got := f.developer.expect("GET", path, nil, 200, ""); !reflect.DeepEqual(got, saved) {
				t.Fatalf("rejected save changed content: got %v, want %v", got, saved)
			}
			// Resolving against the latest revision preserves the winner's
			// name and applies the second editor's description normally.
			input["name"], input["expectedRevision"] = saved["name"], saved["revision"]
			merged := f.developer.expect("PUT", path, input, 200, "")
			if merged["revision"] != float64(3) || merged["name"] != saved["name"] || merged["description"] != input["description"] {
				t.Fatalf("resolution = %v", merged)
			}
		})
	}
	// Impact analysis is also anchored to the editor's revision.
	current := f.developer.expect("GET", "/datasets/"+f.datasetID, nil, 200, "")
	proposal := map[string]any{"name": current["name"], "datasourceId": current["datasourceId"], "spec": current["spec"]}
	f.developer.expect("POST", "/datasets/"+f.datasetID+"/impact", proposal, 400, "revision_required")
	proposal["expectedRevision"] = 1
	f.developer.expect("POST", "/datasets/"+f.datasetID+"/impact", proposal, 409, "resource_revision_conflict")
	if history := f.developer.expect("GET", "/datasets/"+f.datasetID+"/revisions", nil, 200, ""); len(history["items"].([]any)) != 3 {
		t.Fatalf("rejected updates created history: %v", history)
	}
}
