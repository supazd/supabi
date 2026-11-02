package api

import (
	"context"
	"encoding/json"
	"slices"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

func valuesOf[T any](value *map[string]T) map[string]T {
	if value != nil {
		return *value
	}
	return nil
}
func boolOf(value *bool) bool { return value != nil && *value }

func (s *Server) runFilterOptions(ctx context.Context, target loadedDataset, q query.Query, field string, search *string) (gen.FilterOptions, error) {
	out := gen.FilterOptions{Values: []any{}}
	limit := filterOptionLimit
	q.Limit = &limit
	if f, exists := target.spec.FieldByKey(field); exists && f.Type == datasource.String && search != nil && *search != "" {
		if q.Candidates != nil {
			projection := *q.Candidates
			projection.Search = *search
			q.Candidates = &projection
		} else {
			q = content.And(q, []dataset.Filter{{Field: field, Op: "contains", Value: *search}})
		}
	}
	result, err := s.execute(ctx, target.stored, target.spec, &q)
	if err != nil {
		return out, err
	}
	out.Truncated = result.Meta.Truncated
	seen := map[string]bool{}
	for _, row := range result.Rows {
		if len(row) == 0 || row[0] == nil {
			continue
		}
		key, _ := json.Marshal(row[0])
		if !seen[string(key)] {
			seen[string(key)] = true
			out.Values = append(out.Values, row[0])
		}
	}
	return out, nil
}

func (s *Server) chartFilterOptions(ctx context.Context, chart content.ChartSpec, target loadedDataset, id string, in gen.ChartOptionsRequest) (out gen.FilterOptions, err error) {
	defer func() { err = s.datasetFieldError(ctx, target.stored.ID, err) }()
	ctx = withRefresh(ctx, in.Refresh)
	resolved, err := chart.ResolveDynamics(valuesOf(in.Selections))
	if err != nil {
		return gen.FilterOptions{}, err
	}
	f, exists := resolved.FilterByID(id)
	if !exists || !f.Interactive() || f.IsParam() {
		return gen.FilterOptions{}, store.ErrNotFound
	}
	// Validate every submitted filter before returning even the fixed boolean list.
	if _, err := resolved.ForViewer(valuesOf(in.Filters), target.spec); err != nil {
		return gen.FilterOptions{}, err
	}
	operand, err := content.ResolveFilterTarget(&resolved, target.spec, content.FilterTarget{Field: f.Field, Aggregation: f.Aggregation})
	if err != nil {
		return gen.FilterOptions{}, err
	}
	if operand.Aggregate && operand.Type == datasource.Boolean {
		return gen.FilterOptions{Values: []any{false, true}}, nil
	}
	q, field, err := resolved.OptionsQuery(id, valuesOf(in.Filters), target.spec, boolOf(in.Related))
	if err != nil {
		return gen.FilterOptions{}, err
	}
	return s.runFilterOptions(ctx, target, q, field, in.Search)
}

func (s *Server) QueryChartFilterOptions(ctx context.Context, req gen.QueryChartFilterOptionsRequestObject) (gen.QueryChartFilterOptionsResponseObject, error) {
	stored, err := s.getChart(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	var chart content.ChartSpec
	if err := json.Unmarshal(stored.Spec, &chart); err != nil {
		return nil, err
	}
	ds, spec, err := s.loadDataset(ctx, stored.DatasetID)
	if err != nil {
		return nil, err
	}
	body := gen.ChartOptionsRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	out, err := s.chartFilterOptions(ctx, chart, loadedDataset{stored: ds, spec: spec}, req.FilterId, body)
	return gen.QueryChartFilterOptions200JSONResponse(out), err
}

func (s *Server) PreviewChartFilterOptions(ctx context.Context, req gen.PreviewChartFilterOptionsRequestObject) (gen.PreviewChartFilterOptionsResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	var chart content.ChartSpec
	if err := decodeStrict(req.Body.Spec, &chart, "invalid_spec"); err != nil {
		return nil, err
	}
	stored, ds, err := s.loadDataset(ctx, chart.Query.Dataset)
	if err != nil {
		return nil, err
	}
	// A field's settings can be tried before the chart or filter is complete.
	// This endpoint requires dataset.use; viewers cannot supply a draft query.
	chart.Filters = slices.Clone(chart.Filters)
	for i := range chart.Filters {
		if chart.Filters[i].ID == req.FilterId && chart.Filters[i].Control == nil {
			chart.Filters[i].Control = &content.Control{Type: content.ControlSelect, Multi: true}
		}
	}
	out, err := s.chartFilterOptions(ctx, chart, loadedDataset{stored: stored, spec: ds}, req.FilterId, gen.ChartOptionsRequest{Filters: req.Body.Filters, Selections: req.Body.Selections, Search: req.Body.Search, Related: req.Body.Related, Refresh: req.Body.Refresh})
	return gen.PreviewChartFilterOptions200JSONResponse(out), err
}

func (s *Server) dashboardOptions(ctx context.Context, dc *dashboardContext, itemID, filterID string, ownFilter bool, in gen.DashboardFilterOptionsRequest) (out gen.FilterOptions, err error) {
	if ctx, err = withFreshness(ctx, in.Refresh, in.MaxAge); err != nil {
		return gen.FilterOptions{}, err
	}
	item, exists := dc.spec.ItemByID(itemID)
	chart, found := dc.charts[item.ChartID]
	if !exists || !found {
		return gen.FilterOptions{}, store.ErrNotFound
	}
	target := dc.datasets[item.ChartID]
	defer func() { err = s.datasetFieldError(ctx, target.stored.ID, err) }()
	chart, err = chart.ResolveDynamics(valuesOf(in.Selections))
	if err != nil {
		return gen.FilterOptions{}, err
	}
	global, own, useOwn := valuesOf(in.Filters), valuesOf(in.ChartFilters), boolOf(in.UseChartFilters)
	full, err := dc.spec.QueryForViewer(item, &chart, target.spec, global, own, useOwn)
	if err != nil {
		return gen.FilterOptions{}, err
	}
	full, err = s.applyDashboardLinks(ctx, dc, itemID, full, valuesOf(in.Links))
	if err != nil {
		return gen.FilterOptions{}, err
	}
	var operand content.ResolvedFilterTarget
	var keep map[string]bool
	if ownFilter {
		filter, exists := chart.FilterByID(filterID)
		if !exists || !filter.Interactive() || filter.IsParam() {
			return gen.FilterOptions{}, store.ErrNotFound
		}
		operand, err = content.ResolveFilterTarget(&chart, target.spec, content.FilterTarget{Field: filter.Field, Aggregation: filter.Aggregation})
		keep = chart.CascadeRelated(filterID, boolOf(in.Related))
	} else {
		filter, exists := dc.spec.FilterByID(filterID)
		if !exists {
			return gen.FilterOptions{}, store.ErrNotFound
		}
		binding, _ := filter.OptionsTarget()
		operand, err = content.ResolveFilterTarget(&chart, target.spec, binding)
		keep = dc.spec.CascadeRelated(filterID, boolOf(in.Related))
	}
	if err != nil {
		return gen.FilterOptions{}, err
	}
	if operand.Aggregate {
		if operand.Type == datasource.Boolean {
			return gen.FilterOptions{Values: []any{false, true}}, nil
		}
		return gen.FilterOptions{}, badRequest("invalid_filter_options", "aggregate filters do not enumerate source values")
	}
	// Parameters shape the data the options come from, so they stay.
	chart.Filters = slices.DeleteFunc(slices.Clone(chart.Filters), func(f content.ChartFilter) bool {
		return !f.IsParam() && (f.ID == filterID && ownFilter || f.Interactive() && (!ownFilter || !keep[f.ID]))
	})
	selectedOwn := map[string]any{}
	for _, f := range chart.Filters {
		if value, exists := own[f.ID]; exists {
			selectedOwn[f.ID] = value
		}
	}
	selectedGlobal := global
	if !ownFilter {
		selectedGlobal = map[string]any{}
		for _, f := range dc.spec.Filters {
			var value any
			if keep[f.ID] {
				value = f.Default
				if chosen, exists := global[f.ID]; exists {
					value = chosen
				}
				if !slices.ContainsFunc(f.Targets, func(t content.FilterTarget) bool { return t.Item == itemID }) {
					return gen.FilterOptions{}, badRequest("invalid_cascade", "a related filter has no mapping to the option source")
				}
			}
			selectedGlobal[f.ID] = value
		}
	}
	q, err := dc.spec.QueryForViewer(item, &chart, target.spec, selectedGlobal, selectedOwn, useOwn && ownFilter)
	if err != nil {
		return gen.FilterOptions{}, err
	}
	q, err = s.applyDashboardLinks(ctx, dc, itemID, q, valuesOf(in.Links))
	if err != nil {
		return gen.FilterOptions{}, err
	}
	q = content.OptionsProjection(q, operand.Field, full)
	return s.runFilterOptions(ctx, target, q, operand.Field, in.Search)
}

func (s *Server) QueryDashboardFilterOptions(ctx context.Context, req gen.QueryDashboardFilterOptionsRequestObject) (gen.QueryDashboardFilterOptionsResponseObject, error) {
	dc, err := s.loadDashboard(ctx, req.Id, func(spec *content.DashboardSpec) []string { return optionsItems(spec, req.FilterId) })
	if err != nil {
		return nil, err
	}
	f, exists := dc.spec.FilterByID(req.FilterId)
	if !exists {
		return nil, store.ErrNotFound
	}
	target, _ := f.OptionsTarget()
	body := gen.DashboardFilterOptionsRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	out, err := s.dashboardOptions(ctx, dc, target.Item, req.FilterId, false, body)
	return gen.QueryDashboardFilterOptions200JSONResponse(out), err
}

func (s *Server) QueryDashboardChartFilterOptions(ctx context.Context, req gen.QueryDashboardChartFilterOptionsRequestObject) (gen.QueryDashboardChartFilterOptionsResponseObject, error) {
	dc, err := s.loadDashboard(ctx, req.Id, func(*content.DashboardSpec) []string { return []string{req.ItemId} })
	if err != nil {
		return nil, err
	}
	body := gen.DashboardFilterOptionsRequest{}
	if req.Body != nil {
		body = *req.Body
	}
	out, err := s.dashboardOptions(ctx, dc, req.ItemId, req.FilterId, true, body)
	return gen.QueryDashboardChartFilterOptions200JSONResponse(out), err
}

func previewOptionsBody(in *gen.DashboardPreviewRequest) gen.DashboardFilterOptionsRequest {
	return gen.DashboardFilterOptionsRequest{Links: in.Links, Filters: in.Filters, ChartFilters: in.ChartFilters, Selections: in.Selections, UseChartFilters: in.UseChartFilters, Search: in.Search, Related: in.Related, Refresh: in.Refresh, MaxAge: in.MaxAge}
}

func (s *Server) PreviewDashboardChartFilterOptions(ctx context.Context, req gen.PreviewDashboardChartFilterOptionsRequestObject) (gen.PreviewDashboardChartFilterOptionsResponseObject, error) {
	dc, err := s.dashboardPreview(ctx, req.Body, func(*content.DashboardSpec) []string { return []string{req.ItemId} })
	if err != nil {
		return nil, err
	}
	out, err := s.dashboardOptions(ctx, dc, req.ItemId, req.FilterId, true, previewOptionsBody(req.Body))
	return gen.PreviewDashboardChartFilterOptions200JSONResponse(out), err
}
