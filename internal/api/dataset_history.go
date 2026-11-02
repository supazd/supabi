package api

import (
	"context"
	"encoding/json"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/store"
)

func (s *Server) ListDatasetRevisions(ctx context.Context, req gen.ListDatasetRevisionsRequestObject) (gen.ListDatasetRevisionsResponseObject, error) {
	page, err := revisionPage(req.Params.Before, req.Params.Limit, func() error {
		_, err := store.GetDataset(ctx, s.Pool, s.scope(ctx), req.Id)
		return err
	}, func(before, limit int) ([]store.RevisionSummary, error) {
		return store.ListDatasetRevisions(ctx, s.Pool, s.scope(ctx), req.Id, before, limit)
	})
	if err != nil {
		return nil, err
	}
	return gen.ListDatasetRevisions200JSONResponse(page), nil
}

func (s *Server) GetDatasetRevision(ctx context.Context, req gen.GetDatasetRevisionRequestObject) (gen.GetDatasetRevisionResponseObject, error) {
	if req.Revision < 1 {
		return nil, badRequest("invalid_request", "revision must be positive")
	}
	r, err := store.GetDatasetRevision(ctx, s.Pool, s.scope(ctx), req.Id, req.Revision)
	if err != nil {
		return nil, err
	}
	out := gen.DatasetRevision{Revision: r.Revision, Name: r.Name, Description: r.Description,
		DatasourceId: r.DatasourceID, DatasourceName: r.DatasourceName,
		CreatedAt: r.CreatedAt, CreatedBy: r.CreatedBy, CreatedByName: r.CreatedByName}
	if err := json.Unmarshal(r.Spec, &out.Spec); err != nil {
		return nil, err
	}
	return gen.GetDatasetRevision200JSONResponse(out), nil
}
