package store

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDatasetRevisionWithFieldScopeAndLatest(t *testing.T) {
	pool := migrated(t)
	ctx := context.Background()
	scope := Scope{OrgID: DefaultOrgID, WorkspaceID: DefaultWorkspaceID}
	source, err := CreateDatasource(ctx, pool, scope, Datasource{Name: "history", Type: "postgres", Settings: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	ds, err := CreateDataset(ctx, pool, scope, Dataset{Name: "history", DatasourceID: source.ID, SpecVersion: 1, ValidationStatus: "valid", Spec: json.RawMessage(`{"fields":[{"key":"sales","label":"Old"}]}`)})
	if err != nil {
		t.Fatal(err)
	}
	for _, spec := range []string{`{"fields":[{"key":"sales","label":"Latest"}]}`, `{"fields":[]}`} {
		ds.Spec = json.RawMessage(spec)
		ds, err = UpdateDataset(ctx, pool, scope, ds)
		if err != nil {
			t.Fatal(err)
		}
	}
	raw, err := DatasetRevisionWithField(ctx, pool, scope, ds.ID, "sales")
	if err != nil || !strings.Contains(string(raw), "Latest") {
		t.Fatalf("latest historical field = %s, %v", raw, err)
	}
	for _, request := range []struct {
		scope Scope
		key   string
	}{
		{scope, "unknown"},
		{Scope{OrgID: scope.OrgID, WorkspaceID: "another_workspace"}, "sales"},
		{Scope{OrgID: "another_org", WorkspaceID: scope.WorkspaceID}, "sales"},
	} {
		if _, err := DatasetRevisionWithField(ctx, pool, request.scope, ds.ID, request.key); !errors.Is(err, ErrNotFound) {
			t.Errorf("history outside scope or unknown field = %v, want not found", err)
		}
	}
}
