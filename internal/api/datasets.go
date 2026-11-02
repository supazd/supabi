package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

func toSummary(d store.Dataset) gen.DatasetSummary {
	return gen.DatasetSummary{
		Id: d.ID, Name: d.Name, Description: d.Description, DatasourceId: d.DatasourceID, FolderId: d.FolderID,
		Revision: d.Revision, ValidationStatus: gen.DatasetSummaryValidationStatus(d.ValidationStatus), UpdatedAt: d.UpdatedAt,
	}
}

func toDataset(d store.Dataset) (gen.Dataset, error) {
	out := gen.Dataset{
		Id: d.ID, Name: d.Name, Description: d.Description, DatasourceId: d.DatasourceID, FolderId: d.FolderID,
		Revision: d.Revision, ValidationStatus: gen.DatasetValidationStatus(d.ValidationStatus), UpdatedAt: d.UpdatedAt,
	}
	return out, json.Unmarshal(d.Spec, &out.Spec)
}

func (s *Server) ListDatasets(ctx context.Context, _ gen.ListDatasetsRequestObject) (gen.ListDatasetsResponseObject, error) {
	list, err := store.ListDatasets(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := make(gen.ListDatasets200JSONResponse, len(list))
	for i, d := range list {
		out[i] = toSummary(d)
	}
	return out, nil
}

func (s *Server) GetDataset(ctx context.Context, req gen.GetDatasetRequestObject) (gen.GetDatasetResponseObject, error) {
	d, err := store.GetDataset(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	out, err := toDataset(d)
	return gen.GetDataset200JSONResponse(out), err
}

func (s *Server) CreateDataset(ctx context.Context, req gen.CreateDatasetRequestObject) (gen.CreateDatasetResponseObject, error) {
	d, err := s.checkDatasetInput(ctx, req.Body)
	if err != nil {
		return nil, err
	}
	created, err := store.CreateDataset(ctx, s.Pool, s.scope(ctx), d)
	if err != nil {
		return nil, err
	}
	out, err := toDataset(created)
	return gen.CreateDataset201JSONResponse(out), err
}

func (s *Server) UpdateDataset(ctx context.Context, req gen.UpdateDatasetRequestObject) (gen.UpdateDatasetResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := requireRevision(req.Body.ExpectedRevision); err != nil {
		return nil, err
	}
	input := datasetUpdateInput(req.Body)
	current, err := store.GetDataset(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if err := checkDatasetRevision(req.Body.ExpectedRevision, current); err != nil {
		return nil, err
	}
	d, err := s.checkDatasetInput(ctx, input)
	if err != nil {
		return nil, err
	}
	d.ID = req.Id
	var spec dataset.Spec
	if err := json.Unmarshal(d.Spec, &spec); err != nil {
		return nil, err
	}
	if err := s.checkPolicyFields(ctx, req.Id, &spec); err != nil {
		return nil, err
	}
	updated, err := store.UpdateDatasetChecked(ctx, s.Pool, s.scope(ctx), d, func(current store.Dataset, charts []store.Chart, dashboards []store.Dashboard) error {
		if err := checkDatasetRevision(req.Body.ExpectedRevision, current); err != nil {
			return err
		}
		impact, err := analyzeDatasetImpact(current, input, &spec, charts, dashboards)
		if err != nil {
			return err
		}
		if (len(impact.Charts) > 0 || len(impact.Dashboards) > 0) && (req.Body.ImpactToken == nil || *req.Body.ImpactToken != impact.ConfirmationToken) {
			return &apiError{status: 409, code: "dataset_impact_required", message: "review the affected charts and dashboards before saving"}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	out, err := toDataset(updated)
	return gen.UpdateDataset200JSONResponse(out), err
}

func datasetUpdateInput(in *gen.DatasetUpdateInput) *gen.DatasetInput {
	return &gen.DatasetInput{Name: in.Name, Description: in.Description, DatasourceId: in.DatasourceId, Spec: in.Spec, ImpactToken: in.ImpactToken}
}

func (s *Server) DeleteDataset(ctx context.Context, req gen.DeleteDatasetRequestObject) (gen.DeleteDatasetResponseObject, error) {
	if err := store.DeleteDataset(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteDataset204Response{}, nil
}

// previewRows is how many rows a preview shows unless it asks for another
// number: enough to see what the fields hold, few enough to come back at once.
const (
	previewRows    = 100
	maxPreviewRows = 1000
)

// PreviewDataset runs a definition as it stands in the editor. It selects the
// row-level fields without grouping; fields that aggregate have no value per
// row and are left out.
func (s *Server) PreviewDataset(ctx context.Context, req gen.PreviewDatasetRequestObject) (gen.PreviewDatasetResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var spec dataset.Spec
	if err := decodeStrict(req.Body.Spec, &spec, "invalid_spec"); err != nil {
		return nil, err
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	limit := previewRows
	if req.Body.Limit != nil {
		limit = min(max(*req.Body.Limit, 1), maxPreviewRows)
	}
	q := &query.Query{Version: query.CurrentVersion, Mode: query.ModeDetail, Limit: &limit}
	for _, f := range spec.Fields {
		if f.Role != dataset.Metric {
			q.Columns = append(q.Columns, query.DetailColumn{Field: f.Key})
		}
	}
	if len(q.Columns) == 0 {
		return gen.PreviewDataset200JSONResponse{Columns: []gen.ResultColumn{}, Rows: [][]any{}}, nil
	}
	noteObject(ctx, "datasource", req.Body.DatasourceId)
	result, err := s.execute(withRefresh(ctx, req.Body.Refresh), store.Dataset{DatasourceID: req.Body.DatasourceId}, &spec, q)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: 400, code: "unknown_datasource", message: "the data source does not exist", params: map[string]string{"id": req.Body.DatasourceId}}
	}
	if err != nil {
		return nil, err
	}
	return gen.PreviewDataset200JSONResponse(result), nil
}

// checkDatasetInput validates a dataset before it is stored: first what can be
// checked from the definition alone, then against the database.
func (s *Server) checkDatasetInput(ctx context.Context, in *gen.DatasetInput) (store.Dataset, error) {
	var none store.Dataset
	if in == nil {
		return none, badRequest("invalid_request", "a request body is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return none, badRequest("name_required", "name is required")
	}
	var spec dataset.Spec
	if err := decodeStrict(in.Spec, &spec, "invalid_spec"); err != nil {
		return none, err
	}
	if err := spec.Validate(); err != nil {
		return none, err
	}
	source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), in.DatasourceId)
	if errors.Is(err, store.ErrNotFound) {
		return none, &apiError{status: 400, code: "unknown_datasource", message: "the data source does not exist", params: map[string]string{"id": in.DatasourceId}}
	}
	if err != nil {
		return none, err
	}

	status, err := s.validateAgainstDatabase(ctx, source, &spec)
	if err != nil {
		return none, err
	}
	// Store what was validated, not what was sent: same content, canonical form.
	raw, err := json.Marshal(spec)
	if err != nil {
		return none, err
	}
	d := store.Dataset{Name: name, DatasourceID: source.ID, Spec: raw, SpecVersion: spec.SpecVersion, ValidationStatus: status}
	if in.Description != nil {
		d.Description = *in.Description
	}
	return d, nil
}

// validateAgainstDatabase asks the database to check the SQL the dataset will
// generate, by describing two queries without fetching rows: one selecting
// every row-level field, one computing every measure. It returns "valid", or
// "unvalidated" when the database cannot be reached: an outage must not stop
// an analyst from saving their work.
func (s *Server) validateAgainstDatabase(ctx context.Context, source store.Datasource, spec *dataset.Spec) (string, error) {
	conn, err := s.connect(ctx, source)
	if err != nil {
		s.Logger.WarnContext(ctx, "dataset saved without validation: cannot connect", "datasource", source.ID, "error", err)
		return "unvalidated", nil
	}
	ctx, cancel, err := s.withQueryTimeout(ctx)
	if err != nil {
		return "", err
	}
	defer cancel()
	// Times are left as they are: written in a zone, anything would be a time.
	opt := query.Options{Dialect: conn.Dialect(), Now: s.now(), DefaultLimit: 1, MaxLimit: 1, SampleMissingParams: true, RawTimes: true}

	describe := func(q *query.Query) ([]datasource.Column, error) {
		compiled, err := query.Compile(q, spec, opt)
		if err != nil {
			return nil, err
		}
		return conn.Describe(ctx, compiled.SQL, compiled.Args)
	}
	unreachable := func(err error) (string, error) {
		var queryErr *datasource.QueryError
		var specErr *dataset.Error
		if errors.As(err, &queryErr) {
			return "", &apiError{status: 422, code: "dataset_sql_error", message: queryErr.Message}
		}
		// A busy data source is reachable: saving waits for it to have room
		// rather than skipping the checks.
		if errors.As(err, &specErr) || errors.Is(err, datasource.ErrBusy) || errors.Is(err, datasource.ErrQueueTimeout) {
			return "", err
		}
		s.Logger.WarnContext(ctx, "dataset saved without validation", "datasource", source.ID, "error", err)
		return "unvalidated", nil
	}

	mismatch := func(f dataset.Field, actual datasource.Type) error {
		return &apiError{status: 422, code: "field_type_mismatch",
			message: "field " + f.Label + " is declared as " + string(f.Type) + " but the database returns " + string(actual),
			params:  map[string]string{"key": f.Key, "label": f.Label, "declared": string(f.Type), "actual": string(actual)}}
	}

	// Row-level fields, selected without grouping.
	var rowFields []dataset.Field
	rows := &query.Query{Version: query.CurrentVersion, Mode: query.ModeDetail}
	// Measures summed, as a chart starts them, and metrics as they are. This
	// is also what catches a metric that does not aggregate, and a measure
	// that does.
	var measureFields []dataset.Field
	measures := &query.Query{Version: query.CurrentVersion}
	for _, f := range spec.Fields {
		if f.Role != dataset.Metric {
			rowFields = append(rowFields, f)
			rows.Columns = append(rows.Columns, query.DetailColumn{Field: f.Key})
		}
		if f.Role != dataset.Dimension {
			measureFields = append(measureFields, f)
			m := query.Measure{Field: f.Key}
			if f.Role == dataset.MeasureRole {
				m.Agg = dataset.Sum
			}
			measures.Measures = append(measures.Measures, m)
		}
	}

	if len(rowFields) > 0 {
		columns, err := describe(rows)
		if err != nil {
			return unreachable(err)
		}
		for i, f := range rowFields {
			if actual := columns[i].Type; !compatible(f.Type, actual) {
				return "", mismatch(f, actual)
			}
		}
	}
	if len(measureFields) > 0 {
		columns, err := describe(measures)
		if err != nil {
			return unreachable(err)
		}
		for i, f := range measureFields {
			// A sum decides its own result type; only a metric has a
			// declared one to check.
			if actual := columns[i].Type; f.Role == dataset.Metric && !compatible(f.Type, actual) {
				return "", mismatch(f, actual)
			}
		}
	}
	return "valid", nil
}

// compatible reports whether a field declared as one type can be backed by a
// column of another. Numeric types are interchangeable. A condition comes
// back as a whole number from a database that has no type for true and false.
func compatible(declared, actual datasource.Type) bool {
	return declared == actual || (declared.Numeric() && actual.Numeric()) || (declared == datasource.Boolean && actual == datasource.Integer)
}
