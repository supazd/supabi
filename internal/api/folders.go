package api

import (
	"context"
	"strings"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/store"
)

func toFolder(f store.Folder) gen.Folder {
	return gen.Folder{Id: f.ID, Kind: gen.FolderKind(f.Kind), ParentId: f.ParentID, Name: f.Name}
}

// allowKind refuses a kind of folder that does not exist. Organising every
// kind is for developers, which the requirements table sees to.
func allowKind(kind string) error {
	if !store.FolderKind(kind) {
		return badRequest("invalid_kind", "kind must be dashboard, chart or dataset")
	}
	return nil
}

func (s *Server) ListFolders(ctx context.Context, _ gen.ListFoldersRequestObject) (gen.ListFoldersResponseObject, error) {
	folders, err := store.ListFolders(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	// Viewers see dashboards and charts, so only folders of those: how
	// datasets are organised is no business of theirs.
	developer := callerFrom(ctx).role.AtLeast(authz.Developer)
	out := gen.ListFolders200JSONResponse{}
	for _, f := range folders {
		if developer || f.Kind == store.KindDashboard || f.Kind == store.KindChart {
			out = append(out, toFolder(f))
		}
	}
	return out, nil
}

func (s *Server) CreateFolder(ctx context.Context, req gen.CreateFolderRequestObject) (gen.CreateFolderResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := allowKind(string(req.Body.Kind)); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Body.Name)
	if name == "" {
		return nil, badRequest("name_required", "name is required")
	}
	created, err := store.CreateFolder(ctx, s.Pool, s.scope(ctx), store.Folder{Kind: string(req.Body.Kind), ParentID: req.Body.ParentId, Name: name})
	if err != nil {
		return nil, err
	}
	return gen.CreateFolder201JSONResponse(toFolder(created)), nil
}

func (s *Server) UpdateFolder(ctx context.Context, req gen.UpdateFolderRequestObject) (gen.UpdateFolderResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	current, err := store.GetFolder(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if err := allowKind(current.Kind); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(req.Body.Name)
	if name == "" {
		return nil, badRequest("name_required", "name is required")
	}
	updated, err := store.UpdateFolder(ctx, s.Pool, s.scope(ctx), store.Folder{ID: req.Id, ParentID: req.Body.ParentId, Name: name})
	if err != nil {
		return nil, err
	}
	return gen.UpdateFolder200JSONResponse(toFolder(updated)), nil
}

func (s *Server) DeleteFolder(ctx context.Context, req gen.DeleteFolderRequestObject) (gen.DeleteFolderResponseObject, error) {
	current, err := store.GetFolder(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if err := allowKind(current.Kind); err != nil {
		return nil, err
	}
	if err := store.DeleteFolder(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteFolder204Response{}, nil
}

func (s *Server) MoveResource(ctx context.Context, req gen.MoveResourceRequestObject) (gen.MoveResourceResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := allowKind(string(req.Body.Kind)); err != nil {
		return nil, err
	}
	noteObject(ctx, string(req.Body.Kind), req.Body.Id)
	if err := store.MoveToFolder(ctx, s.Pool, s.scope(ctx), string(req.Body.Kind), req.Body.Id, req.Body.FolderId); err != nil {
		return nil, err
	}
	return gen.MoveResource204Response{}, nil
}

func (s *Server) GetUsage(ctx context.Context, req gen.GetUsageRequestObject) (gen.GetUsageResponseObject, error) {
	var usage store.Usage
	var err error
	switch req.Params.Kind {
	case "datasource":
		usage, err = store.DatasourceUsage(ctx, s.Pool, s.scope(ctx), req.Params.Id)
	case "dataset":
		usage, err = store.DatasetUsage(ctx, s.Pool, s.scope(ctx), req.Params.Id)
	case "chart":
		usage, err = store.ChartUsage(ctx, s.Pool, s.scope(ctx), req.Params.Id)
	default:
		return nil, badRequest("invalid_kind", "kind must be datasource, dataset or chart")
	}
	if err != nil {
		return nil, err
	}
	toRefs := func(in []store.Ref) []gen.ResourceRef {
		out := make([]gen.ResourceRef, len(in))
		for i, r := range in {
			out[i] = gen.ResourceRef{Id: r.ID, Name: r.Name}
		}
		return out
	}
	return gen.GetUsage200JSONResponse{Datasets: toRefs(usage.Datasets), Charts: toRefs(usage.Charts), Dashboards: toRefs(usage.Dashboards)}, nil
}
