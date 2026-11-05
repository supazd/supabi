package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// ---- charts ----

func toChart(c store.Chart) (gen.Chart, error) {
	out := gen.Chart{Id: c.ID, Name: c.Name, Description: c.Description, DatasetId: c.DatasetID, FolderId: c.FolderID, UpdatedAt: c.UpdatedAt, Revision: c.Revision}
	if err := json.Unmarshal(c.Spec, &out.Spec); err != nil {
		return out, err
	}
	if viz, ok := out.Spec["viz"].(map[string]any); ok {
		out.VizType, _ = viz["type"].(string)
	}
	return out, nil
}

// toChartShown is a chart with what showing its parameter filters takes from
// its dataset, which viewers cannot read for themselves. Datasets already
// loaded are taken from loaded, which keeps those it loads; it may be nil.
func (s *Server) toChartShown(ctx context.Context, c store.Chart, loaded map[string]*dataset.Spec) (gen.Chart, error) {
	out, err := toChart(c)
	if err != nil {
		return out, err
	}
	var spec content.ChartSpec
	if err := json.Unmarshal(c.Spec, &spec); err != nil {
		return out, err
	}
	if !slices.ContainsFunc(spec.Filters, content.ChartFilter.IsParam) {
		return out, nil
	}
	ds, ok := loaded[c.DatasetID]
	if !ok {
		if _, ds, err = s.loadDataset(ctx, c.DatasetID); err != nil {
			return out, err
		}
		if loaded != nil {
			loaded[c.DatasetID] = ds
		}
	}
	raw, err := json.Marshal(spec.ParamControls(ds))
	if err != nil {
		return out, err
	}
	var params map[string]gen.ParamControl
	if err := json.Unmarshal(raw, &params); err != nil {
		return out, err
	}
	if len(params) > 0 {
		out.Params = &params
	}
	return out, nil
}

func toChartSummary(c store.Chart) (gen.ChartSummary, error) {
	full, err := toChart(c)
	return gen.ChartSummary{Id: full.Id, Name: full.Name, Description: full.Description, DatasetId: full.DatasetId, FolderId: full.FolderId, VizType: full.VizType, UpdatedAt: full.UpdatedAt, Revision: full.Revision}, err
}

func (s *Server) ListCharts(ctx context.Context, _ gen.ListChartsRequestObject) (gen.ListChartsResponseObject, error) {
	charts, err := store.ListCharts(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	visible, err := s.visibleContent(ctx)
	if err != nil {
		return nil, err
	}
	out := gen.ListCharts200JSONResponse{}
	for _, c := range charts {
		if visible != nil && !visible.Charts[c.ID] {
			continue
		}
		summary, err := toChartSummary(c)
		if err != nil {
			return nil, err
		}
		out = append(out, summary)
	}
	return out, nil
}

func (s *Server) GetChart(ctx context.Context, req gen.GetChartRequestObject) (gen.GetChartResponseObject, error) {
	c, err := s.getChart(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	out, err := s.toChartShown(ctx, c, nil)
	return gen.GetChart200JSONResponse(out), err
}

func (s *Server) CreateChart(ctx context.Context, req gen.CreateChartRequestObject) (gen.CreateChartResponseObject, error) {
	c, err := s.checkChartInput(ctx, req.Body)
	if err != nil {
		return nil, err
	}
	created, err := store.CreateChart(ctx, s.Pool, s.scope(ctx), c)
	if err != nil {
		return nil, err
	}
	out, err := s.toChartShown(ctx, created, nil)
	return gen.CreateChart201JSONResponse(out), err
}

func (s *Server) UpdateChart(ctx context.Context, req gen.UpdateChartRequestObject) (gen.UpdateChartResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := requireRevision(req.Body.ExpectedRevision); err != nil {
		return nil, err
	}
	current, err := store.GetChart(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if current.Revision != req.Body.ExpectedRevision {
		return nil, store.ErrRevisionConflict
	}
	c, err := s.checkChartInput(ctx, &gen.ChartInput{Name: req.Body.Name, Description: req.Body.Description, Spec: req.Body.Spec})
	if err != nil {
		return nil, err
	}
	c.ID = req.Id
	c.Revision = req.Body.ExpectedRevision
	if err := s.checkChartStillFits(ctx, c); err != nil {
		return nil, err
	}
	updated, err := store.UpdateChart(ctx, s.Pool, s.scope(ctx), c)
	if err != nil {
		return nil, err
	}
	out, err := s.toChartShown(ctx, updated, nil)
	return gen.UpdateChart200JSONResponse(out), err
}

func (s *Server) DeleteChart(ctx context.Context, req gen.DeleteChartRequestObject) (gen.DeleteChartResponseObject, error) {
	if err := store.DeleteChart(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteChart204Response{}, nil
}

func (s *Server) checkChartInput(ctx context.Context, in *gen.ChartInput) (store.Chart, error) {
	var none store.Chart
	if in == nil {
		return none, badRequest("invalid_request", "a request body is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return none, badRequest("name_required", "name is required")
	}
	var spec content.ChartSpec
	if err := decodeStrict(in.Spec, &spec, "invalid_spec"); err != nil {
		return none, err
	}
	stored, datasetSpec, err := s.loadDataset(ctx, spec.Query.Dataset)
	if errors.Is(err, store.ErrNotFound) {
		return none, &apiError{status: 400, code: "unknown_dataset", message: "the dataset does not exist", params: map[string]string{"id": spec.Query.Dataset}}
	}
	if err != nil {
		return none, err
	}
	source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), stored.DatasourceID)
	if err != nil {
		return none, err
	}
	driver, ok := datasource.Lookup(source.Type)
	if !ok {
		return none, errors.New("no driver for data source type " + source.Type)
	}
	if err := spec.Validate(datasetSpec, driver.Dialect()); err != nil {
		return none, s.datasetFieldError(ctx, stored.ID, err)
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return none, err
	}
	c := store.Chart{Name: name, DatasetID: stored.ID, DatasetRevision: stored.Revision, Spec: raw, SpecVersion: spec.SpecVersion}
	if in.Description != nil {
		c.Description = *in.Description
	}
	return c, nil
}

// checkChartStillFits makes sure a chart that is being changed still offers
// the fields and aggregate outputs used by dashboards showing it.
func (s *Server) checkChartStillFits(ctx context.Context, c store.Chart) error {
	var changed content.ChartSpec
	if err := json.Unmarshal(c.Spec, &changed); err != nil {
		return err
	}
	usage, err := store.ChartUsage(ctx, s.Pool, s.scope(ctx), c.ID)
	if err != nil {
		return err
	}
	for _, ref := range usage.Dashboards {
		dc, err := s.loadDashboard(ctx, ref.ID, nil)
		if err != nil {
			return err
		}
		// Keep filters bound to this chart and their entire cascade component.
		// Dropping a parent would make a valid dashboard look already broken.
		var items []string
		for _, item := range dc.spec.Widgets() {
			if item.ChartID == c.ID {
				items = append(items, item.ID)
			}
		}
		keep := map[string]bool{}
		for _, f := range dc.spec.Filters {
			if !slices.ContainsFunc(f.Targets, func(t content.FilterTarget) bool { return slices.Contains(items, t.Item) }) {
				continue
			}
			keep[f.ID] = true
			for id := range dc.spec.CascadeRelated(f.ID, true) {
				keep[id] = true
			}
		}
		dc.spec.Filters = slices.DeleteFunc(dc.spec.Filters, func(f content.Filter) bool { return !keep[f.ID] })
		dc.spec.Links = slices.DeleteFunc(dc.spec.Links, func(l content.Link) bool {
			return !slices.Contains(items, l.Source.Item) && !slices.ContainsFunc(l.Targets, func(t content.FilterTarget) bool { return slices.Contains(items, t.Item) })
		})
		if len(dc.spec.Filters) == 0 && len(dc.spec.Links) == 0 {
			continue
		}
		// A dashboard that is already broken was not broken by this change, and
		// must not keep its charts from being edited.
		if broken, err := s.dashboardFits(ctx, dc, c.ID); err != nil || broken != nil {
			if err != nil {
				return err
			}
			continue
		}
		storedDataset, datasetSpec, err := s.loadDataset(ctx, c.DatasetID)
		if err != nil {
			return err
		}
		dc.charts[c.ID] = changed
		dc.datasets[c.ID] = loadedDataset{stored: storedDataset, spec: datasetSpec}
		broken, err := s.dashboardFits(ctx, dc, c.ID)
		if err != nil {
			return err
		}
		if broken != nil {
			return &apiError{status: http.StatusConflict, code: "filter_in_use", message: "a filter of dashboard " + ref.Name + " relies on a field or measure this change removes or alters: " + broken.Message,
				params: map[string]string{"dashboard": ref.Name, "id": broken.Params["id"]}}
		}
	}
	return nil
}

// dashboardFits checks the dashboard's global filters, and the queries of the
// widgets showing chartID, against the charts in dc. A problem with the
// dashboard is returned as broken; err is for failing to check at all.
func (s *Server) dashboardFits(ctx context.Context, dc *dashboardContext, chartID string) (broken *dataset.Error, err error) {
	err = dc.spec.CheckFilters(dc.chart)
	if err == nil {
		err = s.validateDashboardQueries(ctx, dc, chartID)
	}
	if errors.As(err, &broken) {
		return broken, nil
	}
	return nil, err
}

// GetChartData runs the chart's saved query. The caller supplies no query of
// their own, only values for the filters the chart offers, which is what
// makes this safe to offer to viewers.
func (s *Server) GetChartData(ctx context.Context, req gen.GetChartDataRequestObject) (gen.GetChartDataResponseObject, error) {
	chart, err := s.getChart(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	var spec content.ChartSpec
	if err := json.Unmarshal(chart.Spec, &spec); err != nil {
		return nil, err
	}
	stored, datasetSpec, err := s.loadDataset(ctx, chart.DatasetID)
	if err != nil {
		return nil, err
	}
	body := gen.ChartDataRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	result, err := s.chartData(ctx, spec, stored, datasetSpec, body)
	if err != nil {
		return nil, err
	}
	return gen.GetChartData200JSONResponse(result), nil
}

// PreviewChartData runs an unsaved chart the way GetChartData runs a saved
// one. The chart editor asks for it once its chart is drilled, so that the
// drill is resolved here and nowhere else. It requires the developer role.
func (s *Server) PreviewChartData(ctx context.Context, req gen.PreviewChartDataRequestObject) (gen.PreviewChartDataResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var spec content.ChartSpec
	if err := decodeStrict(req.Body.Spec, &spec, "invalid_spec"); err != nil {
		return nil, err
	}
	stored, datasetSpec, err := s.loadDataset(ctx, spec.Query.Dataset)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: 400, code: "unknown_dataset", message: "the dataset does not exist", params: map[string]string{"id": spec.Query.Dataset}}
	}
	if err != nil {
		return nil, err
	}
	noteObject(ctx, "dataset", stored.ID)
	source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), stored.DatasourceID)
	if err != nil {
		return nil, err
	}
	driver, ok := datasource.Lookup(source.Type)
	if !ok {
		return nil, errors.New("no driver for data source type " + source.Type)
	}
	if err := spec.Validate(datasetSpec, driver.Dialect()); err != nil {
		return nil, s.datasetFieldError(ctx, stored.ID, err)
	}
	result, err := s.chartData(ctx, spec, stored, datasetSpec, gen.ChartDataRequest{
		Diagnostics: req.Body.Diagnostics, Refresh: req.Body.Refresh, Selections: req.Body.Selections, Filters: req.Body.Filters, Drill: req.Body.Drill,
	})
	if err != nil {
		return nil, err
	}
	return gen.PreviewChartData200JSONResponse(result), nil
}

// chartData runs a chart for the values a caller gives: its dynamic choices,
// its filters' values and the drill path, nothing else.
func (s *Server) chartData(ctx context.Context, spec content.ChartSpec, stored store.Dataset, datasetSpec *dataset.Spec, body gen.ChartDataRequest) (gen.QueryResult, error) {
	ctx, err := withQueryDiagnostics(ctx, body.Diagnostics)
	if err != nil {
		return gen.QueryResult{}, err
	}
	spec, err = spec.ResolveDynamics(valuesOf(body.Selections))
	if err != nil {
		return gen.QueryResult{}, err
	}
	spec, drilled, err := s.drill(ctx, spec, body.Drill, datasetSpec)
	if err != nil {
		return gen.QueryResult{}, s.datasetFieldError(ctx, stored.ID, err)
	}
	q, err := spec.ForViewer(valuesOf(body.Filters), datasetSpec)
	if err != nil {
		return gen.QueryResult{}, s.datasetFieldError(ctx, stored.ID, err)
	}
	q = content.And(q, drilled)
	return s.execute(withRefresh(ctx, body.Refresh), stored, datasetSpec, &q)
}

// drill takes the chart down to the level the viewer's path leads to. The
// conditions it returns go after every other, so that the drilled value is
// kept within whatever else restricts the chart.
func (s *Server) drill(ctx context.Context, chart content.ChartSpec, path *gen.DrillPath, ds *dataset.Spec) (content.ChartSpec, []dataset.Filter, error) {
	if path == nil || len(*path) == 0 {
		return chart, nil, nil
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return chart, nil, err
	}
	return chart.Drilled(*path, ds, workspace.Timezone, workspace.WeekStart)
}

func (s *Server) GetChartFilterOptions(ctx context.Context, req gen.GetChartFilterOptionsRequestObject) (gen.GetChartFilterOptionsResponseObject, error) {
	chart, err := s.getChart(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	var spec content.ChartSpec
	if err := json.Unmarshal(chart.Spec, &spec); err != nil {
		return nil, err
	}
	f, ok := spec.FilterByID(req.FilterId)
	if !ok || !f.Interactive() {
		return nil, store.ErrNotFound
	}
	stored, datasetSpec, err := s.loadDataset(ctx, chart.DatasetID)
	if err != nil {
		return nil, err
	}
	out, err := s.chartFilterOptions(ctx, spec, loadedDataset{stored: stored, spec: datasetSpec}, f.ID, gen.ChartOptionsRequest{Search: req.Params.Search})
	return gen.GetChartFilterOptions200JSONResponse(out), err
}

// ---- dashboards ----

func toDashboardSummary(d store.Dashboard) gen.DashboardSummary {
	return gen.DashboardSummary{Id: d.ID, Name: d.Name, Description: d.Description, FolderId: d.FolderID, UpdatedAt: d.UpdatedAt, Revision: d.Revision}
}

// toDashboard includes the charts the dashboard shows.
func (s *Server) toDashboard(ctx context.Context, d store.Dashboard) (gen.Dashboard, error) {
	out := gen.Dashboard{Id: d.ID, Name: d.Name, Description: d.Description, FolderId: d.FolderID, UpdatedAt: d.UpdatedAt, Revision: d.Revision, Charts: []gen.Chart{}}
	if err := json.Unmarshal(d.Spec, &out.Spec); err != nil {
		return out, err
	}
	var spec content.DashboardSpec
	if err := json.Unmarshal(d.Spec, &spec); err != nil {
		return out, err
	}
	charts, err := store.GetCharts(ctx, s.Pool, s.scope(ctx), spec.ChartIDs())
	if err != nil {
		return out, err
	}
	if len(spec.Filters) > 0 || len(spec.Links) > 0 {
		// Bindings are returned upgraded, so that the editor submits them as
		// they will be stored.
		dc, err := s.dashboardContext(ctx, spec, charts)
		if err != nil {
			return out, err
		}
		raw, err := json.Marshal(dc.spec)
		if err != nil {
			return out, err
		}
		if err := json.Unmarshal(raw, &out.Spec); err != nil {
			return out, err
		}
	}
	loaded := map[string]*dataset.Spec{}
	for _, c := range charts {
		chart, err := s.toChartShown(ctx, c, loaded)
		if err != nil {
			return out, err
		}
		out.Charts = append(out.Charts, chart)
	}
	return out, nil
}

func (s *Server) ListDashboards(ctx context.Context, _ gen.ListDashboardsRequestObject) (gen.ListDashboardsResponseObject, error) {
	list, err := store.ListDashboards(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	visible, err := s.visibleContent(ctx)
	if err != nil {
		return nil, err
	}
	out := gen.ListDashboards200JSONResponse{}
	for _, d := range list {
		if visible == nil || visible.Dashboards[d.ID] {
			out = append(out, toDashboardSummary(d))
		}
	}
	return out, nil
}

func (s *Server) GetDashboard(ctx context.Context, req gen.GetDashboardRequestObject) (gen.GetDashboardResponseObject, error) {
	d, err := s.getDashboard(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	out, err := s.toDashboard(ctx, d)
	return gen.GetDashboard200JSONResponse(out), err
}

func (s *Server) CreateDashboard(ctx context.Context, req gen.CreateDashboardRequestObject) (gen.CreateDashboardResponseObject, error) {
	saved, err := s.saveDashboard(ctx, "", req.Body, 0)
	if err != nil {
		return nil, err
	}
	return gen.CreateDashboard201JSONResponse(saved), nil
}

func (s *Server) UpdateDashboard(ctx context.Context, req gen.UpdateDashboardRequestObject) (gen.UpdateDashboardResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := requireRevision(req.Body.ExpectedRevision); err != nil {
		return nil, err
	}
	current, err := store.GetDashboard(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if current.Revision != req.Body.ExpectedRevision {
		return nil, store.ErrRevisionConflict
	}
	saved, err := s.saveDashboard(ctx, req.Id, &gen.DashboardInput{Name: req.Body.Name, Description: req.Body.Description, Spec: req.Body.Spec}, req.Body.ExpectedRevision)
	if err != nil {
		return nil, err
	}
	return gen.UpdateDashboard200JSONResponse(saved), nil
}

func (s *Server) saveDashboard(ctx context.Context, dashboardID string, in *gen.DashboardInput, revision int) (gen.Dashboard, error) {
	var none gen.Dashboard
	if in == nil {
		return none, badRequest("invalid_request", "a request body is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return none, badRequest("name_required", "name is required")
	}
	var spec content.DashboardSpec
	if err := decodeStrict(in.Spec, &spec, "invalid_spec"); err != nil {
		return none, err
	}
	if err := spec.Validate(); err != nil {
		return none, err
	}
	chartIDs := spec.ChartIDs()
	existing, err := store.GetCharts(ctx, s.Pool, s.scope(ctx), chartIDs)
	if err != nil {
		return none, err
	}
	for _, chartID := range chartIDs {
		if !slices.ContainsFunc(existing, func(c store.Chart) bool { return c.ID == chartID }) {
			return none, &apiError{status: 400, code: "unknown_chart", message: "the chart does not exist", params: map[string]string{"id": chartID}}
		}
	}
	datasetRevisions := map[string]int{}
	if len(spec.Filters) > 0 || len(spec.Links) > 0 {
		dc, err := s.dashboardContext(ctx, spec, existing)
		if err != nil {
			return none, err
		}
		spec = dc.spec
		if err := spec.CheckFilters(dc.chart); err != nil {
			return none, s.datasetFieldError(ctx, "", err)
		}
		if err := s.validateDashboardQueries(ctx, dc, ""); err != nil {
			return none, err
		}
		for _, loaded := range dc.datasets {
			datasetRevisions[loaded.stored.ID] = loaded.stored.Revision
		}
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		return none, err
	}
	d := store.Dashboard{ID: dashboardID, Name: name, Spec: raw, SpecVersion: spec.SpecVersion, Revision: revision, DatasetRevisions: datasetRevisions, ChartUpdatedAt: map[string]time.Time{}}
	for _, chart := range existing {
		d.ChartUpdatedAt[chart.ID] = chart.UpdatedAt
	}
	if in.Description != nil {
		d.Description = *in.Description
	}
	saved, err := store.SaveDashboard(ctx, s.Pool, s.scope(ctx), d, chartIDs)
	if err != nil {
		return none, err
	}
	return s.toDashboard(ctx, saved)
}

func (s *Server) DeleteDashboard(ctx context.Context, req gen.DeleteDashboardRequestObject) (gen.DeleteDashboardResponseObject, error) {
	if err := store.DeleteDashboard(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteDashboard204Response{}, nil
}

// ---- dashboard data ----

const filterOptionLimit = 500

// dashboardContext is a dashboard with the charts it shows and their datasets.
type dashboardContext struct {
	name        string // empty for a draft
	description string
	revision    int // zero for a draft
	spec        content.DashboardSpec
	charts      map[string]content.ChartSpec
	names       map[string]string        // chart names, by chart id
	revisions   map[string]int           // chart revisions, by chart id
	datasets    map[string]loadedDataset // by chart id
}

type loadedDataset struct {
	stored store.Dataset
	spec   *dataset.Spec
}

// loadDashboard loads a saved dashboard. Only the charts of scope's widgets are
// loaded with it, or all of them when scope is nil: a request about one widget
// must not cost a load of every chart and dataset on the board.
func (s *Server) loadDashboard(ctx context.Context, dashboardID string, scope func(*content.DashboardSpec) []string) (*dashboardContext, error) {
	d, err := s.getDashboard(ctx, dashboardID)
	if err != nil {
		return nil, err
	}
	var spec content.DashboardSpec
	if err := json.Unmarshal(d.Spec, &spec); err != nil {
		return nil, err
	}
	chartIDs := spec.ChartIDs()
	if scope != nil {
		chartIDs = spec.ChartIDsOf(spec.LinkItems(scope(&spec)...)...)
	}
	charts, err := store.GetCharts(ctx, s.Pool, s.scope(ctx), chartIDs)
	if err != nil {
		return nil, err
	}
	dc, err := s.dashboardContext(ctx, spec, charts)
	if err != nil {
		return nil, err
	}
	dc.name, dc.description, dc.revision = d.Name, d.Description, d.Revision
	return dc, nil
}

// chart returns a chart of the dashboard with its dataset.
func (dc *dashboardContext) chart(chartID string) (*content.ChartSpec, *dataset.Spec, bool) {
	spec, ok := dc.charts[chartID]
	if !ok {
		return nil, nil, false
	}
	return &spec, dc.datasets[chartID].spec, true
}

func (s *Server) dashboardContext(ctx context.Context, spec content.DashboardSpec, charts []store.Chart) (*dashboardContext, error) {
	dc := &dashboardContext{spec: spec, charts: map[string]content.ChartSpec{}, names: map[string]string{}, revisions: map[string]int{}, datasets: map[string]loadedDataset{}}
	byDataset := map[string]loadedDataset{}
	for _, c := range charts {
		var spec content.ChartSpec
		if err := json.Unmarshal(c.Spec, &spec); err != nil {
			return nil, err
		}
		dc.charts[c.ID] = spec
		dc.names[c.ID] = c.Name
		dc.revisions[c.ID] = c.Revision
		loaded, ok := byDataset[c.DatasetID]
		if !ok {
			stored, datasetSpec, err := s.loadDataset(ctx, c.DatasetID)
			if err != nil {
				return nil, err
			}
			loaded = loadedDataset{stored: stored, spec: datasetSpec}
			byDataset[c.DatasetID] = loaded
		}
		dc.datasets[c.ID] = loaded
	}
	dc.spec.NormalizeFilters(dc.chart)
	return dc, nil
}

// Validate saved defaults by compiling, without querying the source. Empty
// controls are still checked by CheckFilters; nonempty values also need the
// query compiler's type and time-range validation. With chartID given, only
// the widgets showing that chart are compiled.
func (s *Server) validateDashboardQueries(ctx context.Context, dc *dashboardContext, chartID string) error {
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return err
	}
	for _, item := range dc.spec.Widgets() {
		if !item.HoldsChart() || (chartID != "" && item.ChartID != chartID) {
			continue
		}
		chart := dc.charts[item.ChartID]
		chart, err := chart.ResolveDynamics(nil)
		if err != nil {
			return err
		}
		target := dc.datasets[item.ChartID]
		q, err := dc.spec.QueryForViewer(item, &chart, target.spec, nil, nil, false)
		if err != nil {
			return s.datasetFieldError(ctx, target.stored.ID, err)
		}
		source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), target.stored.DatasourceID)
		if err != nil {
			return err
		}
		driver, ok := datasource.Lookup(source.Type)
		if !ok {
			return errors.New("no driver for data source type " + source.Type)
		}
		if _, err := query.Compile(&q, target.spec, query.Options{
			Dialect: driver.Dialect(), Now: s.now(), Timezone: workspace.Timezone, WeekStart: workspace.WeekStart,
			DefaultLimit: 1, MaxLimit: 1, SampleMissingParams: true,
		}); err != nil {
			return s.datasetFieldError(ctx, target.stored.ID, err)
		}
	}
	return nil
}

// GetDashboardItemData runs one widget's chart as the dashboard shows it. The
// caller contributes values only; every field involved comes from the
// dashboard's and the charts' own definitions.
func (s *Server) GetDashboardItemData(ctx context.Context, req gen.GetDashboardItemDataRequestObject) (gen.GetDashboardItemDataResponseObject, error) {
	dc, err := s.loadDashboard(ctx, req.Id, func(*content.DashboardSpec) []string { return []string{req.ItemId} })
	if err != nil {
		return nil, err
	}
	body := gen.DashboardDataRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	result, err := s.dashboardItemData(ctx, dc, req.ItemId, body)
	return gen.GetDashboardItemData200JSONResponse(result), err
}

func (s *Server) dashboardItemData(ctx context.Context, dc *dashboardContext, itemID string, body gen.DashboardDataRequest) (gen.QueryResult, error) {
	result, _, err := s.dashboardItemResult(ctx, dc, itemID, body)
	return result, err
}

// dashboardItemResult is a widget's data with the chart that drew it, its
// dynamic choices and drill-down resolved.
func (s *Server) dashboardItemResult(ctx context.Context, dc *dashboardContext, itemID string, body gen.DashboardDataRequest) (result gen.QueryResult, chart content.ChartSpec, err error) {
	q, chart, target, err := s.dashboardItemQuery(ctx, dc, itemID, body)
	if err != nil {
		return gen.QueryResult{}, chart, err
	}
	defer func() { err = s.datasetFieldError(ctx, target.stored.ID, err) }()
	item, _ := dc.spec.ItemByID(itemID)
	useChartFilters := body.UseChartFilters != nil && *body.UseChartFilters
	overridden := []string{}
	if !useChartFilters {
		overridden, err = dc.spec.OverriddenFilters(item, &chart, target.spec)
		if err != nil {
			return gen.QueryResult{}, chart, err
		}
	}
	if ctx, err = withFreshness(ctx, body.Refresh, body.MaxAge); err != nil {
		return gen.QueryResult{}, chart, err
	}
	result, err = s.execute(ctx, target.stored, target.spec, &q)
	if err != nil {
		return gen.QueryResult{}, chart, err
	}
	result.Meta.OverriddenFilters = &overridden
	return result, chart, nil
}

// dashboardItemQuery is the query a widget runs for the values the caller
// gives, with the chart as its dynamic choices resolve it.
func (s *Server) dashboardItemQuery(ctx context.Context, dc *dashboardContext, itemID string, body gen.DashboardDataRequest) (q query.Query, chart content.ChartSpec, target loadedDataset, err error) {
	item, ok := dc.spec.ItemByID(itemID)
	chart, found := dc.charts[item.ChartID]
	if !ok || !found {
		return q, chart, target, store.ErrNotFound
	}
	target = dc.datasets[item.ChartID]
	defer func() { err = s.datasetFieldError(ctx, target.stored.ID, err) }()

	var global, own map[string]any
	if body.Filters != nil {
		global = *body.Filters
	}
	if body.ChartFilters != nil {
		own = *body.ChartFilters
	}
	useChartFilters := body.UseChartFilters != nil && *body.UseChartFilters
	chart, err = chart.ResolveDynamics(valuesOf(body.Selections))
	if err != nil {
		return q, chart, target, err
	}
	chart, drilled, err := s.drill(ctx, chart, body.Drill, target.spec)
	if err != nil {
		return q, chart, target, err
	}
	q, err = dc.spec.QueryForViewer(item, &chart, target.spec, global, own, useChartFilters)
	if err != nil {
		return q, chart, target, err
	}
	q, err = s.applyDashboardLinks(ctx, dc, itemID, q, valuesOf(body.Links))
	return content.And(q, drilled), chart, target, err
}

func (s *Server) GetDashboardFilterOptions(ctx context.Context, req gen.GetDashboardFilterOptionsRequestObject) (gen.GetDashboardFilterOptionsResponseObject, error) {
	dc, err := s.loadDashboard(ctx, req.Id, func(spec *content.DashboardSpec) []string { return optionsItems(spec, req.FilterId) })
	if err != nil {
		return nil, err
	}
	out, err := s.dashboardFilterOptions(ctx, dc, req.FilterId, req.Params.Search)
	return gen.GetDashboardFilterOptions200JSONResponse(out), err
}

// optionsItems is the widget whose field supplies a global filter's options.
func optionsItems(spec *content.DashboardSpec, filterID string) []string {
	f, ok := spec.FilterByID(filterID)
	if !ok {
		return nil
	}
	target, _ := f.OptionsTarget()
	return []string{target.Item}
}

func (s *Server) dashboardFilterOptions(ctx context.Context, dc *dashboardContext, filterID string, search *string) (gen.FilterOptions, error) {
	f, ok := dc.spec.FilterByID(filterID)
	if !ok {
		return gen.FilterOptions{}, store.ErrNotFound
	}
	target, _ := f.OptionsTarget()
	return s.dashboardOptions(ctx, dc, target.Item, filterID, false, gen.DashboardFilterOptionsRequest{Search: search})
}

func (s *Server) applyDashboardLinks(ctx context.Context, dc *dashboardContext, itemID string, q query.Query, values map[string]any) (query.Query, error) {
	if len(values) == 0 {
		return q, nil
	}
	scoped := dc.spec
	scoped.Links = dc.spec.ScopedLinks(itemID)
	if err := scoped.CheckLinks(dc.chart); err != nil {
		return q, err
	}
	workspace, err := store.GetWorkspace(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return q, err
	}
	return dc.spec.ApplyLinks(q, itemID, values, dc.chart, workspace.Timezone, workspace.WeekStart)
}
