package api

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/store"
)

// Announcements that administrators publish, and the bell and banner that
// show them: .agents/design/announcements.md.

const (
	announcementTitleMax = 120
	announcementBodyMax  = 10_000
	// bellPage is how many notifications a page of the bell holds, and
	// bannerLines how many announcements the banner shows.
	bellPage    = 20
	bannerLines = 3
)

func toAnnouncement(a store.Announcement) gen.Announcement {
	return gen.Announcement{Id: a.ID, Title: a.Title, Body: a.Body, StartsAt: a.StartsAt, EndsAt: a.EndsAt, CreatedBy: a.CreatedByName, CreatedAt: a.CreatedAt, UpdatedAt: a.UpdatedAt}
}

func toNotification(a store.Announcement) gen.Notification {
	n := gen.Notification{Id: a.ID, Kind: gen.NotificationKindAnnouncement, Category: gen.NotificationCategorySystem, Title: a.Title, Body: a.Body,
		StartsAt: a.StartsAt, EndsAt: a.EndsAt, Unread: a.Unread}
	if a.WorkspaceID != "" {
		n.Category, n.WorkspaceId, n.WorkspaceName = gen.NotificationCategoryWorkspace, &a.WorkspaceID, &a.WorkspaceName
	}
	return n
}

// announcementScope is where an operation's announcements are: the
// organization's for system ones, the current workspace's otherwise.
func (s *Server) announcementScope(ctx context.Context, system bool) store.Scope {
	sc := s.scope(ctx)
	if system {
		sc.WorkspaceID = ""
	}
	return sc
}

// announcementFrom checks what an administrator submitted. was is the
// announcement being changed, nil for a new one: a start or an end left as
// it was may be in the past, so that an ended announcement can still be
// corrected, but a new or changed one may not.
func (s *Server) announcementFrom(in *gen.AnnouncementInput, was *store.Announcement) (store.Announcement, error) {
	if in == nil {
		return store.Announcement{}, badRequest("invalid_request", "a request body is required")
	}
	// The wall clock, not the server's adjustable one: the database's clock
	// decides what is shown, and the two agree.
	now := time.Now()
	a := store.Announcement{Title: strings.TrimSpace(in.Title), EndsAt: in.EndsAt, StartsAt: now, StartNow: in.StartsAt == nil}
	if in.Body != nil {
		// Leading spaces can mean something in Markdown; blank lines cannot.
		a.Body = strings.TrimRight(strings.TrimLeft(*in.Body, "\r\n"), " \t\r\n")
	}
	if in.StartsAt != nil {
		a.StartsAt = *in.StartsAt
	}
	switch {
	case a.Title == "" || strings.ContainsAny(a.Title, "\r\n") || utf8.RuneCountInString(a.Title) > announcementTitleMax:
		return a, badRequest("announcement_title", "the title must be one line of 1 to 120 characters")
	case utf8.RuneCountInString(a.Body) > announcementBodyMax:
		return a, badRequest("announcement_body_too_long", "the body can be at most 10000 characters")
	case !a.EndsAt.After(now) && (was == nil || !a.EndsAt.Equal(was.EndsAt)):
		return a, badRequest("announcement_end_past", "the end must be in the future")
	case in.StartsAt != nil && a.StartsAt.Before(now) && (was == nil || !a.StartsAt.Equal(was.StartsAt)):
		return a, badRequest("announcement_start_past", "the start cannot be in the past")
	case !a.EndsAt.After(a.StartsAt):
		return a, badRequest("announcement_ends_before_start", "the announcement must end after it starts")
	}
	return a, nil
}

func (s *Server) listAnnouncements(ctx context.Context, system bool) ([]gen.Announcement, error) {
	list, err := store.ListAnnouncements(ctx, s.Pool, s.announcementScope(ctx, system))
	if err != nil {
		return nil, err
	}
	out := make([]gen.Announcement, len(list))
	for i, a := range list {
		out[i] = toAnnouncement(a)
	}
	return out, nil
}

func (s *Server) createAnnouncement(ctx context.Context, system bool, in *gen.AnnouncementInput) (gen.Announcement, error) {
	a, err := s.announcementFrom(in, nil)
	if err != nil {
		return gen.Announcement{}, err
	}
	a, err = store.CreateAnnouncement(ctx, s.Pool, s.announcementScope(ctx, system), a)
	return toAnnouncement(a), err
}

func (s *Server) updateAnnouncement(ctx context.Context, system bool, id string, in *gen.AnnouncementInput) (gen.Announcement, error) {
	sc := s.announcementScope(ctx, system)
	was, err := store.GetAnnouncement(ctx, s.Pool, sc, id)
	if err != nil {
		return gen.Announcement{}, err
	}
	a, err := s.announcementFrom(in, &was)
	if err != nil {
		return gen.Announcement{}, err
	}
	a.ID = id
	a, err = store.UpdateAnnouncement(ctx, s.Pool, sc, a)
	return toAnnouncement(a), err
}

func (s *Server) endAnnouncement(ctx context.Context, system bool, id string) (gen.Announcement, error) {
	a, err := store.EndAnnouncement(ctx, s.Pool, s.announcementScope(ctx, system), id)
	if errors.Is(err, store.ErrConflict) {
		return gen.Announcement{}, &apiError{status: 409, code: "announcement_not_in_effect", message: "only an announcement in effect can be ended; edit or delete one that has not started"}
	}
	return toAnnouncement(a), err
}

// ---- system announcements ----

func (s *Server) ListSystemAnnouncements(ctx context.Context, _ gen.ListSystemAnnouncementsRequestObject) (gen.ListSystemAnnouncementsResponseObject, error) {
	out, err := s.listAnnouncements(ctx, true)
	return gen.ListSystemAnnouncements200JSONResponse(out), err
}

func (s *Server) CreateSystemAnnouncement(ctx context.Context, req gen.CreateSystemAnnouncementRequestObject) (gen.CreateSystemAnnouncementResponseObject, error) {
	a, err := s.createAnnouncement(ctx, true, req.Body)
	if err != nil {
		return nil, err
	}
	return gen.CreateSystemAnnouncement201JSONResponse(a), nil
}

func (s *Server) UpdateSystemAnnouncement(ctx context.Context, req gen.UpdateSystemAnnouncementRequestObject) (gen.UpdateSystemAnnouncementResponseObject, error) {
	a, err := s.updateAnnouncement(ctx, true, req.Id, req.Body)
	if err != nil {
		return nil, err
	}
	return gen.UpdateSystemAnnouncement200JSONResponse(a), nil
}

func (s *Server) EndSystemAnnouncement(ctx context.Context, req gen.EndSystemAnnouncementRequestObject) (gen.EndSystemAnnouncementResponseObject, error) {
	a, err := s.endAnnouncement(ctx, true, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.EndSystemAnnouncement200JSONResponse(a), nil
}

func (s *Server) DeleteSystemAnnouncement(ctx context.Context, req gen.DeleteSystemAnnouncementRequestObject) (gen.DeleteSystemAnnouncementResponseObject, error) {
	if err := store.DeleteAnnouncement(ctx, s.Pool, s.announcementScope(ctx, true), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteSystemAnnouncement204Response{}, nil
}

// ---- workspace announcements ----

func (s *Server) ListWorkspaceAnnouncements(ctx context.Context, _ gen.ListWorkspaceAnnouncementsRequestObject) (gen.ListWorkspaceAnnouncementsResponseObject, error) {
	out, err := s.listAnnouncements(ctx, false)
	return gen.ListWorkspaceAnnouncements200JSONResponse(out), err
}

func (s *Server) CreateWorkspaceAnnouncement(ctx context.Context, req gen.CreateWorkspaceAnnouncementRequestObject) (gen.CreateWorkspaceAnnouncementResponseObject, error) {
	a, err := s.createAnnouncement(ctx, false, req.Body)
	if err != nil {
		return nil, err
	}
	return gen.CreateWorkspaceAnnouncement201JSONResponse(a), nil
}

func (s *Server) UpdateWorkspaceAnnouncement(ctx context.Context, req gen.UpdateWorkspaceAnnouncementRequestObject) (gen.UpdateWorkspaceAnnouncementResponseObject, error) {
	a, err := s.updateAnnouncement(ctx, false, req.Id, req.Body)
	if err != nil {
		return nil, err
	}
	return gen.UpdateWorkspaceAnnouncement200JSONResponse(a), nil
}

func (s *Server) EndWorkspaceAnnouncement(ctx context.Context, req gen.EndWorkspaceAnnouncementRequestObject) (gen.EndWorkspaceAnnouncementResponseObject, error) {
	a, err := s.endAnnouncement(ctx, false, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.EndWorkspaceAnnouncement200JSONResponse(a), nil
}

func (s *Server) DeleteWorkspaceAnnouncement(ctx context.Context, req gen.DeleteWorkspaceAnnouncementRequestObject) (gen.DeleteWorkspaceAnnouncementResponseObject, error) {
	if err := store.DeleteAnnouncement(ctx, s.Pool, s.announcementScope(ctx, false), req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteWorkspaceAnnouncement204Response{}, nil
}

// ---- the caller's bell and banner ----

// GetNotificationSummary is read by every open page, every refresh interval:
// it returns the interval in force, so pages follow a change of it.
func (s *Server) GetNotificationSummary(ctx context.Context, _ gen.GetNotificationSummaryRequestObject) (gen.GetNotificationSummaryResponseObject, error) {
	p := callerFrom(ctx).principal
	summary, err := store.SummarizeNotifications(ctx, s.Pool, p.OrgID, p.UserID, p.WorkspaceID, bannerLines)
	if err != nil {
		return nil, err
	}
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, p.OrgID)
	if err != nil {
		return nil, err
	}
	out := gen.NotificationSummary{Unread: summary.Unread, Banner: make([]gen.Notification, len(summary.Banner)), BannerTotal: summary.BannerTotal,
		RefreshSeconds: int(settings.NotificationRefresh / time.Second)}
	for i, a := range summary.Banner {
		out.Banner[i] = toNotification(a)
	}
	return gen.GetNotificationSummary200JSONResponse(out), nil
}

func (s *Server) ListNotifications(ctx context.Context, req gen.ListNotificationsRequestObject) (gen.ListNotificationsResponseObject, error) {
	p := callerFrom(ctx).principal
	var category string
	if req.Params.Category != nil {
		category = string(*req.Params.Category)
		if category != "system" && category != "workspace" {
			return nil, badRequest("invalid_request", "category must be system or workspace")
		}
	}
	list, err := store.ListShownAnnouncements(ctx, s.Pool, p.OrgID, p.UserID, category, req.Params.Before, bellPage)
	if err != nil {
		return nil, err
	}
	out := gen.NotificationPage{Items: make([]gen.Notification, len(list))}
	for i, a := range list {
		out.Items[i] = toNotification(a)
	}
	if len(list) == bellPage {
		out.NextBefore = &list[len(list)-1].StartsAt
	}
	return gen.ListNotifications200JSONResponse(out), nil
}

func (s *Server) MarkNotificationRead(ctx context.Context, req gen.MarkNotificationReadRequestObject) (gen.MarkNotificationReadResponseObject, error) {
	p := callerFrom(ctx).principal
	if err := store.ReadAnnouncement(ctx, s.Pool, p.OrgID, p.UserID, req.Id); err != nil {
		return nil, err
	}
	return gen.MarkNotificationRead204Response{}, nil
}

func (s *Server) MarkAllNotificationsRead(ctx context.Context, _ gen.MarkAllNotificationsReadRequestObject) (gen.MarkAllNotificationsReadResponseObject, error) {
	p := callerFrom(ctx).principal
	if err := store.ReadAllAnnouncements(ctx, s.Pool, p.OrgID, p.UserID); err != nil {
		return nil, err
	}
	return gen.MarkAllNotificationsRead204Response{}, nil
}
