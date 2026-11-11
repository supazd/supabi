package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/store"
)

// maxViewState is the most a share link's conditions may take: far more than
// any real choice of filters, little enough not to fill the database.
const maxViewState = 64 << 10

// CreateDashboardView keeps the conditions a dashboard is shared with, for a
// share link to name by its ID (.agents/design/chart-dashboard.md 3.10). Anyone
// who can open the dashboard can share it; the link grants nothing.
func (s *Server) CreateDashboardView(ctx context.Context, req gen.CreateDashboardViewRequestObject) (gen.CreateDashboardViewResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if !req.Body.ValidDays.Valid() {
		return nil, badRequest("invalid_valid_days", "validDays must be 1, 7, 30 or 90")
	}
	d, err := s.getDashboard(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	view, state, err := s.saveView(ctx, d.ID, req.Body.State, time.Duration(req.Body.ValidDays)*24*time.Hour)
	if err != nil {
		return nil, err
	}
	return gen.CreateDashboardView201JSONResponse{Id: view.ID, State: state, ExpiresAt: view.ExpiresAt}, nil
}

// saveView keeps conditions to open a dashboard with, for a link to name
// them by an ID, which the same conditions kept for as long keep: asked for
// a shorter time, they get a link of their own, since one already sent must
// not expire sooner (.agents/design/chart-dashboard.md 3.10). The caller has
// checked that the dashboard can be opened.
func (s *Server) saveView(ctx context.Context, dashboardID string, state gen.DashboardViewState, validFor time.Duration) (store.DashboardView, gen.DashboardViewState, error) {
	state = canonicalViewState(state)
	encoded, err := json.Marshal(state)
	if err != nil {
		return store.DashboardView{}, state, err
	}
	if len(encoded) > maxViewState {
		return store.DashboardView{}, state, badRequest("view_too_large", "the shared conditions are too large")
	}
	sum := sha256.Sum256(fmt.Appendf(slices.Clone(encoded), "\nvalid for %d s", int64(validFor.Seconds())))
	view, err := store.SaveDashboardView(ctx, s.Pool, s.scope(ctx), dashboardID, encoded, hex.EncodeToString(sum[:]), validFor)
	return view, state, err
}

// GetDashboardView returns the conditions a share link carries, to whoever
// can open the dashboard, until they expire.
func (s *Server) GetDashboardView(ctx context.Context, req gen.GetDashboardViewRequestObject) (gen.GetDashboardViewResponseObject, error) {
	d, err := s.getDashboard(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	view, err := store.OpenDashboardView(ctx, s.Pool, s.scope(ctx), d.ID, req.ViewId)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: 404, code: "view_not_found", message: "the shared conditions have expired or do not exist"}
	}
	if err != nil {
		return nil, err
	}
	var state gen.DashboardViewState
	if err := json.Unmarshal(view.State, &state); err != nil {
		return nil, err
	}
	return gen.GetDashboardView200JSONResponse{Id: view.ID, State: state, ExpiresAt: view.ExpiresAt}, nil
}

// canonicalViewState writes the same conditions the same way, so that sharing
// them again finds the same link: empty parts are left out, charts at their
// first level among them, and the widgets using their own filters are sorted.
// Maps are encoded in key order anyway.
func canonicalViewState(in gen.DashboardViewState) gen.DashboardViewState {
	out := gen.DashboardViewState{}
	if in.Filters != nil && len(*in.Filters) > 0 {
		out.Filters = in.Filters
	}
	if in.Links != nil && len(*in.Links) > 0 {
		out.Links = in.Links
	}
	if in.ChartFilters != nil {
		kept := map[string]map[string]any{}
		for item, values := range *in.ChartFilters {
			if len(values) > 0 {
				kept[item] = values
			}
		}
		if len(kept) > 0 {
			out.ChartFilters = &kept
		}
	}
	if in.Selections != nil {
		kept := map[string]map[string]string{}
		for item, values := range *in.Selections {
			if len(values) > 0 {
				kept[item] = values
			}
		}
		if len(kept) > 0 {
			out.Selections = &kept
		}
	}
	if in.Drill != nil {
		kept := map[string]gen.DrillState{}
		for item, position := range *in.Drill {
			if len(position.Steps) > 0 {
				kept[item] = position
			}
		}
		if len(kept) > 0 {
			out.Drill = &kept
		}
	}
	if in.Tabs != nil && len(*in.Tabs) > 0 {
		out.Tabs = in.Tabs
	}
	if in.Page != nil && *in.Page != "" {
		out.Page = in.Page
	}
	if in.UseChartFilters != nil && len(*in.UseChartFilters) > 0 {
		items := slices.Clone(*in.UseChartFilters)
		slices.Sort(items)
		items = slices.Compact(items)
		out.UseChartFilters = &items
	}
	return out
}
