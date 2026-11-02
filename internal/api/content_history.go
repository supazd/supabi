package api

import (
	"context"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/store"
)

func (s *Server) ListChartRevisions(ctx context.Context, req gen.ListChartRevisionsRequestObject) (gen.ListChartRevisionsResponseObject, error) {
	page, err := revisionPage(req.Params.Before, req.Params.Limit, func() error {
		_, err := store.GetChart(ctx, s.Pool, s.scope(ctx), req.Id)
		return err
	}, func(before, limit int) ([]store.RevisionSummary, error) {
		return store.ListChartRevisions(ctx, s.Pool, s.scope(ctx), req.Id, before, limit)
	})
	if err != nil {
		return nil, err
	}
	return gen.ListChartRevisions200JSONResponse(page), nil
}

func (s *Server) ListDashboardRevisions(ctx context.Context, req gen.ListDashboardRevisionsRequestObject) (gen.ListDashboardRevisionsResponseObject, error) {
	page, err := revisionPage(req.Params.Before, req.Params.Limit, func() error {
		_, err := store.GetDashboard(ctx, s.Pool, s.scope(ctx), req.Id)
		return err
	}, func(before, limit int) ([]store.RevisionSummary, error) {
		return store.ListDashboardRevisions(ctx, s.Pool, s.scope(ctx), req.Id, before, limit)
	})
	if err != nil {
		return nil, err
	}
	return gen.ListDashboardRevisions200JSONResponse(page), nil
}

// revisionPage checks the paging parameters, then that the resource exists
// (an unknown one is not found rather than an empty history), and reads one
// page. It asks for one more than the page holds to know whether older
// revisions remain.
func revisionPage(beforeParam, limitParam *int, exists func() error, list func(before, limit int) ([]store.RevisionSummary, error)) (gen.RevisionPage, error) {
	page := gen.RevisionPage{Items: []gen.RevisionSummary{}}
	before, limit := 0, 30
	if beforeParam != nil {
		before = *beforeParam
		if before < 1 {
			return page, badRequest("invalid_request", "before must be a positive revision")
		}
	}
	if limitParam != nil {
		limit = *limitParam
	}
	if limit < 1 || limit > 100 {
		return page, badRequest("invalid_request", "limit must be between 1 and 100")
	}
	if err := exists(); err != nil {
		return page, err
	}
	rows, err := list(before, limit+1)
	if err != nil {
		return page, err
	}
	if len(rows) > limit {
		next := rows[limit-1].Revision
		page.NextBefore = &next
		rows = rows[:limit]
	}
	for _, r := range rows {
		page.Items = append(page.Items, gen.RevisionSummary{Revision: r.Revision, Name: r.Name, CreatedAt: r.CreatedAt, CreatedBy: r.CreatedBy, CreatedByName: r.CreatedByName})
	}
	return page, nil
}
