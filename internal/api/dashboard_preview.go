package api

import (
	"context"
	"slices"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/store"
)

// dashboardPreview validates a draft without storing it. Charts remain saved
// resources: the request can arrange and filter them, never replace their query.
// Each request is about one widget, so only the charts of the widgets scope
// returns are loaded, and only their bindings are checked: the editor asks for
// every widget at once, and each must not cost a load of the whole board.
func (s *Server) dashboardPreview(ctx context.Context, in *gen.DashboardPreviewRequest, scope func(*content.DashboardSpec) []string) (*dashboardContext, error) {
	if in == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var spec content.DashboardSpec
	if err := decodeStrict(in.Spec, &spec, "invalid_spec"); err != nil {
		return nil, err
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	items := scope(&spec)
	chartIDs := spec.ChartIDsOf(spec.LinkItems(items...)...)
	charts, err := store.GetCharts(ctx, s.Pool, s.scope(ctx), chartIDs)
	if err != nil {
		return nil, err
	}
	for _, chartID := range chartIDs {
		if !slices.ContainsFunc(charts, func(c store.Chart) bool { return c.ID == chartID }) {
			return nil, &apiError{status: 400, code: "unknown_chart", message: "the chart does not exist", params: map[string]string{"id": chartID}}
		}
	}
	dc, err := s.dashboardContext(ctx, spec, charts)
	if err != nil {
		return nil, err
	}
	scoped := dc.spec
	scoped.Filters = dc.spec.ScopedFilters(items...)
	scoped.Links = dc.spec.ScopedLinks(items...)
	if err := scoped.CheckFilters(dc.chart); err != nil {
		return nil, s.datasetFieldError(ctx, "", err)
	}
	return dc, nil
}

func (s *Server) PreviewDashboardItemData(ctx context.Context, req gen.PreviewDashboardItemDataRequestObject) (gen.PreviewDashboardItemDataResponseObject, error) {
	dc, err := s.dashboardPreview(ctx, req.Body, func(*content.DashboardSpec) []string { return []string{req.ItemId} })
	if err != nil {
		return nil, err
	}
	result, err := s.dashboardItemData(ctx, dc, req.ItemId, gen.DashboardDataRequest{
		Links: req.Body.Links, Filters: req.Body.Filters, ChartFilters: req.Body.ChartFilters, UseChartFilters: req.Body.UseChartFilters, Selections: req.Body.Selections, Refresh: req.Body.Refresh, MaxAge: req.Body.MaxAge, Drill: req.Body.Drill,
	})
	return gen.PreviewDashboardItemData200JSONResponse(result), err
}

func (s *Server) PreviewDashboardFilterOptions(ctx context.Context, req gen.PreviewDashboardFilterOptionsRequestObject) (gen.PreviewDashboardFilterOptionsResponseObject, error) {
	dc, err := s.dashboardPreview(ctx, req.Body, func(spec *content.DashboardSpec) []string { return optionsItems(spec, req.FilterId) })
	if err != nil {
		return nil, err
	}
	f, exists := dc.spec.FilterByID(req.FilterId)
	if !exists {
		return nil, store.ErrNotFound
	}
	target, _ := f.OptionsTarget()
	result, err := s.dashboardOptions(ctx, dc, target.Item, req.FilterId, false, previewOptionsBody(req.Body))
	return gen.PreviewDashboardFilterOptions200JSONResponse(result), err
}
