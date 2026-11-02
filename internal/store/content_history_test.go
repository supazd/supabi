package store

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

// A chart's revision records the dataset revision it was saved against,
// which moves on as the dataset changes; a save that fails records nothing.
func TestChartRevisionsFollowTheirDataset(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	source, err := CreateDatasource(ctx, pool, scope, Datasource{Name: "history", Type: "postgres", Settings: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	ds, err := CreateDataset(ctx, pool, scope, Dataset{Name: "history", DatasourceID: source.ID, SpecVersion: 1, ValidationStatus: "valid", Spec: json.RawMessage(`{"fields":[]}`)})
	if err != nil {
		t.Fatal(err)
	}
	chart, err := CreateChart(ctx, pool, scope, Chart{Name: "A", DatasetID: ds.ID, DatasetRevision: ds.Revision, Spec: json.RawMessage(`{}`), SpecVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if ds, err = UpdateDataset(ctx, pool, scope, ds); err != nil {
		t.Fatal(err)
	}
	chart.Name, chart.DatasetRevision = "B", ds.Revision
	if chart, err = UpdateChart(ctx, pool, scope, chart); err != nil {
		t.Fatal(err)
	}
	stale := chart
	stale.Revision = 1
	if _, err := UpdateChart(ctx, pool, scope, stale); err == nil {
		t.Fatal("a stale save succeeded")
	}
	rows, err := pool.Query(ctx, `SELECT revision, name, dataset_revision FROM chart_revisions WHERE chart_id = $1 ORDER BY revision`, chart.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for rows.Next() {
		var revision, datasetRevision int
		var name string
		if err := rows.Scan(&revision, &name, &datasetRevision); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%d %s %d", revision, name, datasetRevision))
	}
	if want := "[1 A 1 2 B 2]"; fmt.Sprint(got) != want {
		t.Errorf("chart revisions = %v, want %s", got, want)
	}
	summaries, err := ListChartRevisions(ctx, pool, Scope{OrgID: DefaultOrgID, WorkspaceID: "another_workspace"}, chart.ID, 0, 30)
	if err != nil || len(summaries) != 0 {
		t.Errorf("history from another workspace = %v, %v", summaries, err)
	}
}
