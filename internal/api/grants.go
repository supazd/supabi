package api

import (
	"context"
	"net/http"
	"slices"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/store"
)

// ---- subjects ----

func toSubject(sub authz.Subject) gen.Subject {
	var out gen.Subject
	switch {
	case sub.Everyone:
		out.Everyone = new(true)
	case sub.GroupID != "":
		out.Group = new(sub.GroupID)
	default:
		out.User = new(sub.UserID)
	}
	return out
}

func toSubjects(subs []authz.Subject) []gen.Subject {
	out := make([]gen.Subject, len(subs))
	for i, sub := range subs {
		out[i] = toSubject(sub)
	}
	return out
}

// checkSubjects reads subjects and makes sure each names one user or group of
// the caller's org, or every member. Repeats are dropped.
func (s *Server) checkSubjects(ctx context.Context, in []gen.Subject) ([]authz.Subject, error) {
	orgID := s.scope(ctx).OrgID
	users, err := store.ListUsers(ctx, s.Pool, orgID)
	if err != nil {
		return nil, err
	}
	groups, err := store.ListGroups(ctx, s.Pool, orgID)
	if err != nil {
		return nil, err
	}
	out := []authz.Subject{}
	for _, item := range in {
		var sub authz.Subject
		if item.User != nil {
			sub.UserID = *item.User
		}
		if item.Group != nil {
			sub.GroupID = *item.Group
		}
		sub.Everyone = item.Everyone != nil && *item.Everyone
		switch {
		case !sub.Valid():
			return nil, badRequest("invalid_subject", "a subject names exactly one user, one group, or every member")
		case sub.UserID != "" && !slices.ContainsFunc(users, func(u store.User) bool { return u.ID == sub.UserID }):
			return nil, &apiError{status: http.StatusBadRequest, code: "unknown_user", message: "the user does not exist", params: map[string]string{"id": sub.UserID}}
		case sub.GroupID != "" && !slices.ContainsFunc(groups, func(g store.Group) bool { return g.ID == sub.GroupID }):
			return nil, &apiError{status: http.StatusBadRequest, code: "unknown_group", message: "the group does not exist", params: map[string]string{"id": sub.GroupID}}
		}
		if !slices.Contains(out, sub) {
			out = append(out, sub)
		}
	}
	return out, nil
}

// ---- dashboard grants ----

func (s *Server) GetDashboardGrants(ctx context.Context, req gen.GetDashboardGrantsRequestObject) (gen.GetDashboardGrantsResponseObject, error) {
	subs, err := store.ListDashboardGrants(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	return gen.GetDashboardGrants200JSONResponse{Subjects: toSubjects(subs)}, nil
}

func (s *Server) SetDashboardGrants(ctx context.Context, req gen.SetDashboardGrantsRequestObject) (gen.SetDashboardGrantsResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	subs, err := s.checkSubjects(ctx, req.Body.Subjects)
	if err != nil {
		return nil, err
	}
	if err := store.SetDashboardGrants(ctx, s.Pool, s.scope(ctx), req.Id, subs); err != nil {
		return nil, err
	}
	return gen.SetDashboardGrants200JSONResponse{Subjects: toSubjects(subs)}, nil
}

// ---- what a viewer sees ----

// visibleContent returns the dashboards and charts the caller may see, or
// nil when they may see all of them: developers and admins do.
func (s *Server) visibleContent(ctx context.Context) (*store.Visible, error) {
	c := callerFrom(ctx)
	if c.role.AtLeast(authz.Developer) {
		return nil, nil
	}
	visible, err := store.VisibleContent(ctx, s.Pool, s.scope(ctx), c.principal.UserID)
	return &visible, err
}

// getChart loads a chart the caller may see. One a viewer may not see is not
// found, so they cannot learn it exists.
func (s *Server) getChart(ctx context.Context, chartID string) (store.Chart, error) {
	visible, err := s.visibleContent(ctx)
	if err != nil {
		return store.Chart{}, err
	}
	if visible != nil && !visible.Charts[chartID] {
		return store.Chart{}, store.ErrNotFound
	}
	return store.GetChart(ctx, s.Pool, s.scope(ctx), chartID)
}

// getDashboard loads a dashboard the caller may see, as getChart does a chart.
func (s *Server) getDashboard(ctx context.Context, dashboardID string) (store.Dashboard, error) {
	visible, err := s.visibleContent(ctx)
	if err != nil {
		return store.Dashboard{}, err
	}
	if visible != nil && !visible.Dashboards[dashboardID] {
		return store.Dashboard{}, store.ErrNotFound
	}
	return store.GetDashboard(ctx, s.Pool, s.scope(ctx), dashboardID)
}
