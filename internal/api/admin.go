package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/store"
)

// Changing your own role, status or administrator flag is how administrators
// lock themselves out, so another administrator has to do it.
var errChangeSelf = badRequest("cannot_change_self", "ask another administrator to change your own account or membership")

// ---- roles ----

// checkRole makes sure a role is one of the three before it is assigned.
func checkRole(role gen.WorkspaceRole) (authz.Role, error) {
	r := authz.Role(role)
	if !r.Valid() {
		return "", &apiError{status: http.StatusBadRequest, code: "unknown_role", message: "the role does not exist", params: map[string]string{"role": string(role)}}
	}
	return r, nil
}

// ---- users ----

func toUser(u store.User) gen.User {
	return gen.User{Id: u.ID, Email: u.Email, DisplayName: u.DisplayName, Status: gen.UserStatus(u.Status), IsOrgAdmin: u.IsOrgAdmin}
}

func (s *Server) ListUsers(ctx context.Context, _ gen.ListUsersRequestObject) (gen.ListUsersResponseObject, error) {
	users, err := store.ListUsers(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	out := make(gen.ListUsers200JSONResponse, len(users))
	for i, u := range users {
		out[i] = toUser(u)
	}
	return out, nil
}

func (s *Server) CreateUser(ctx context.Context, req gen.CreateUserRequestObject) (gen.CreateUserResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	email, name, hash, err := checkNewAccount(req.Body.Email, req.Body.DisplayName, req.Body.Password)
	if err != nil {
		return nil, err
	}
	user := store.User{Email: email, DisplayName: name, PasswordHash: hash, IsOrgAdmin: req.Body.IsOrgAdmin != nil && *req.Body.IsOrgAdmin}
	created, err := store.CreateUser(ctx, s.Pool, s.scope(ctx).OrgID, user)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "email_taken", message: "an account with this email already exists"}
	}
	if err != nil {
		return nil, err
	}
	return gen.CreateUser201JSONResponse(toUser(created)), nil
}

func (s *Server) UpdateUser(ctx context.Context, req gen.UpdateUserRequestObject) (gen.UpdateUserResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	scope := s.scope(ctx)
	var change store.UserChange
	if req.Body.DisplayName != nil {
		name := strings.TrimSpace(*req.Body.DisplayName)
		if name == "" {
			return nil, badRequest("name_required", "name is required")
		}
		change.DisplayName = &name
	}
	if req.Body.Status != nil {
		status := string(*req.Body.Status)
		if status != store.UserActive && status != store.UserDisabled {
			return nil, badRequest("invalid_status", "status must be active or disabled")
		}
		change.Status = &status
	}
	change.IsOrgAdmin = req.Body.IsOrgAdmin
	if req.Id == scope.UserID && (change.Status != nil || change.IsOrgAdmin != nil) {
		return nil, errChangeSelf
	}
	if req.Body.Password != nil {
		hash, err := auth.HashPassword(*req.Body.Password)
		if err != nil {
			return nil, badRequest("invalid_password", err.Error())
		}
		change.PasswordHash = &hash
	}
	updated, err := store.UpdateUser(ctx, s.Pool, scope.OrgID, req.Id, change)
	if err != nil {
		return nil, err
	}
	return gen.UpdateUser200JSONResponse(toUser(updated)), nil
}

// ---- groups ----

func toGroup(g store.Group) gen.Group {
	if g.UserIDs == nil {
		g.UserIDs = []string{}
	}
	return gen.Group{Id: g.ID, Name: g.Name, UserIds: g.UserIDs}
}

func (s *Server) ListGroups(ctx context.Context, _ gen.ListGroupsRequestObject) (gen.ListGroupsResponseObject, error) {
	groups, err := store.ListGroups(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	out := make(gen.ListGroups200JSONResponse, len(groups))
	for i, g := range groups {
		out[i] = toGroup(g)
	}
	return out, nil
}

func (s *Server) saveGroup(ctx context.Context, groupID string, in *gen.GroupInput) (gen.Group, error) {
	var none gen.Group
	if in == nil {
		return none, badRequest("invalid_request", "a request body is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return none, badRequest("name_required", "name is required")
	}
	orgID := s.scope(ctx).OrgID
	users, err := store.ListUsers(ctx, s.Pool, orgID)
	if err != nil {
		return none, err
	}
	var userIDs []string
	for _, userID := range in.UserIds {
		if !slices.ContainsFunc(users, func(u store.User) bool { return u.ID == userID }) {
			return none, &apiError{status: 400, code: "unknown_user", message: "the user does not exist", params: map[string]string{"id": userID}}
		}
		if !slices.Contains(userIDs, userID) {
			userIDs = append(userIDs, userID)
		}
	}
	saved, err := store.SaveGroup(ctx, s.Pool, orgID, store.Group{ID: groupID, Name: name, UserIDs: userIDs})
	return toGroup(saved), err
}

func (s *Server) CreateGroup(ctx context.Context, req gen.CreateGroupRequestObject) (gen.CreateGroupResponseObject, error) {
	g, err := s.saveGroup(ctx, "", req.Body)
	if err != nil {
		return nil, err
	}
	return gen.CreateGroup201JSONResponse(g), nil
}

func (s *Server) UpdateGroup(ctx context.Context, req gen.UpdateGroupRequestObject) (gen.UpdateGroupResponseObject, error) {
	g, err := s.saveGroup(ctx, req.Id, req.Body)
	if err != nil {
		return nil, err
	}
	return gen.UpdateGroup200JSONResponse(g), nil
}

func (s *Server) DeleteGroup(ctx context.Context, req gen.DeleteGroupRequestObject) (gen.DeleteGroupResponseObject, error) {
	if err := store.DeleteGroup(ctx, s.Pool, s.scope(ctx).OrgID, req.Id); err != nil {
		return nil, err
	}
	return gen.DeleteGroup204Response{}, nil
}

// ---- workspace members ----

func toMember(m store.Member) gen.Member {
	return gen.Member{UserId: m.UserID, Email: m.Email, DisplayName: m.DisplayName, Status: gen.MemberStatus(m.Status), IsOrgAdmin: m.IsOrgAdmin, Role: gen.WorkspaceRole(m.Role)}
}

func (s *Server) ListMembers(ctx context.Context, _ gen.ListMembersRequestObject) (gen.ListMembersResponseObject, error) {
	members, err := store.ListMembers(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := make(gen.ListMembers200JSONResponse, len(members))
	for i, m := range members {
		out[i] = toMember(m)
	}
	return out, nil
}

func (s *Server) AddMember(ctx context.Context, req gen.AddMemberRequestObject) (gen.AddMemberResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	scope := s.scope(ctx)
	if _, err := store.GetUser(ctx, s.Pool, scope.OrgID, req.Body.UserId); errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: 400, code: "unknown_user", message: "the user does not exist", params: map[string]string{"id": req.Body.UserId}}
	} else if err != nil {
		return nil, err
	}
	role, err := checkRole(req.Body.Role)
	if err != nil {
		return nil, err
	}
	member, err := store.AddMember(ctx, s.Pool, scope, req.Body.UserId, role)
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "already_member", message: "the user already belongs to the workspace"}
	}
	if err != nil {
		return nil, err
	}
	return gen.AddMember201JSONResponse(toMember(member)), nil
}

func (s *Server) UpdateMember(ctx context.Context, req gen.UpdateMemberRequestObject) (gen.UpdateMemberResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	scope := s.scope(ctx)
	if req.UserId == scope.UserID {
		return nil, errChangeSelf
	}
	role, err := checkRole(req.Body.Role)
	if err != nil {
		return nil, err
	}
	member, err := store.SetMemberRole(ctx, s.Pool, scope, req.UserId, role)
	if err != nil {
		return nil, err
	}
	return gen.UpdateMember200JSONResponse(toMember(member)), nil
}

func (s *Server) RemoveMember(ctx context.Context, req gen.RemoveMemberRequestObject) (gen.RemoveMemberResponseObject, error) {
	scope := s.scope(ctx)
	if req.UserId == scope.UserID {
		return nil, errChangeSelf
	}
	if err := store.RemoveMember(ctx, s.Pool, scope, req.UserId); err != nil {
		return nil, err
	}
	return gen.RemoveMember204Response{}, nil
}

func (s *Server) ListGroupMembers(ctx context.Context, _ gen.ListGroupMembersRequestObject) (gen.ListGroupMembersResponseObject, error) {
	grants, err := store.ListGroupGrants(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := make(gen.ListGroupMembers200JSONResponse, len(grants))
	for i, g := range grants {
		out[i] = gen.GroupMember{GroupId: g.GroupID, Name: g.Name, Role: gen.WorkspaceRole(g.Role)}
	}
	return out, nil
}

func (s *Server) SetGroupMember(ctx context.Context, req gen.SetGroupMemberRequestObject) (gen.SetGroupMemberResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	scope := s.scope(ctx)
	groups, err := store.ListGroups(ctx, s.Pool, scope.OrgID)
	if err != nil {
		return nil, err
	}
	index := slices.IndexFunc(groups, func(g store.Group) bool { return g.ID == req.GroupId })
	if index < 0 {
		return nil, store.ErrNotFound
	}
	role, err := checkRole(req.Body.Role)
	if err != nil {
		return nil, err
	}
	if err := store.SetGroupRole(ctx, s.Pool, scope, req.GroupId, role); err != nil {
		return nil, err
	}
	return gen.SetGroupMember200JSONResponse{GroupId: req.GroupId, Name: groups[index].Name, Role: gen.WorkspaceRole(role)}, nil
}

func (s *Server) RemoveGroupMember(ctx context.Context, req gen.RemoveGroupMemberRequestObject) (gen.RemoveGroupMemberResponseObject, error) {
	if err := store.RemoveGroupGrant(ctx, s.Pool, s.scope(ctx), req.GroupId); err != nil {
		return nil, err
	}
	return gen.RemoveGroupMember204Response{}, nil
}

// ---- workspaces ----

func toWorkspace(w store.Workspace) gen.Workspace {
	return gen.Workspace{Id: w.ID, Name: w.Name, Timezone: w.Timezone, WeekStart: w.WeekStart, FirstWeekDays: gen.FirstWeekDays(w.FirstWeekDays), DeletedAt: w.DeletedAt}
}

// withPurgeAt says when a workspace deleted goes for good. The date is worked
// out here, not stored, so that a change of the retention applies to it.
func (s *Server) withPurgeAt(ctx context.Context, list ...store.Workspace) ([]gen.Workspace, error) {
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	out := make([]gen.Workspace, len(list))
	for i, w := range list {
		out[i] = toWorkspace(w)
		if w.DeletedAt != nil {
			out[i].PurgeAt = new(w.DeletedAt.Add(settings.WorkspaceRetention))
		}
	}
	return out, nil
}

func (s *Server) ListWorkspaces(ctx context.Context, _ gen.ListWorkspacesRequestObject) (gen.ListWorkspacesResponseObject, error) {
	scope := s.scope(ctx)
	list, err := store.ListWorkspaces(ctx, s.Pool, scope.OrgID, scope.UserID, callerFrom(ctx).principal.IsOrgAdmin)
	if err != nil {
		return nil, err
	}
	out, err := s.withPurgeAt(ctx, list...)
	return gen.ListWorkspaces200JSONResponse(out), err
}

func checkWorkspaceInput(in *gen.WorkspaceInput) (store.Workspace, error) {
	var none store.Workspace
	if in == nil {
		return none, badRequest("invalid_request", "a request body is required")
	}
	w := store.Workspace{Name: strings.TrimSpace(in.Name), Timezone: "UTC", WeekStart: dialect.Monday, FirstWeekDays: 4}
	if w.Name == "" {
		return none, badRequest("name_required", "name is required")
	}
	if in.Timezone != nil && *in.Timezone != "" {
		w.Timezone = *in.Timezone
	}
	if _, err := time.LoadLocation(w.Timezone); err != nil || w.Timezone == "Local" {
		return none, &apiError{status: 400, code: "invalid_timezone", message: "unknown time zone " + w.Timezone, params: map[string]string{"timezone": w.Timezone}}
	}
	if in.WeekStart != nil {
		w.WeekStart = *in.WeekStart
	}
	if w.WeekStart != dialect.Monday && w.WeekStart != dialect.Sunday {
		return none, badRequest("invalid_week_start", "weeks start on Monday (1) or Sunday (7)")
	}
	if in.FirstWeekDays != nil {
		w.FirstWeekDays = *in.FirstWeekDays
	}
	if !gen.FirstWeekDays(w.FirstWeekDays).Valid() {
		return none, badRequest("invalid_first_week_days", "the first week of a year has 1, 4 or 7 of its days in it")
	}
	return w, nil
}

func (s *Server) CreateWorkspace(ctx context.Context, req gen.CreateWorkspaceRequestObject) (gen.CreateWorkspaceResponseObject, error) {
	w, err := checkWorkspaceInput(req.Body)
	if err != nil {
		return nil, err
	}
	created, err := store.CreateWorkspace(ctx, s.Pool, s.scope(ctx), w)
	if err != nil {
		return nil, err
	}
	return gen.CreateWorkspace201JSONResponse(toWorkspace(created)), nil
}

func (s *Server) UpdateWorkspace(ctx context.Context, req gen.UpdateWorkspaceRequestObject) (gen.UpdateWorkspaceResponseObject, error) {
	w, err := checkWorkspaceInput(req.Body)
	if err != nil {
		return nil, err
	}
	updated, err := store.UpdateWorkspace(ctx, s.Pool, s.scope(ctx), w)
	if err != nil {
		return nil, err
	}
	return gen.UpdateWorkspace200JSONResponse(toWorkspace(updated)), nil
}

func (s *Server) DeleteWorkspace(ctx context.Context, req gen.DeleteWorkspaceRequestObject) (gen.DeleteWorkspaceResponseObject, error) {
	deleted, err := store.DeleteWorkspace(ctx, s.Pool, s.scope(ctx).OrgID, req.Id, callerFrom(ctx).tokenHash)
	if err != nil {
		return nil, err
	}
	out, err := s.withPurgeAt(ctx, deleted)
	if err != nil {
		return nil, err
	}
	return gen.DeleteWorkspace200JSONResponse(out[0]), nil
}

func (s *Server) RestoreWorkspace(ctx context.Context, req gen.RestoreWorkspaceRequestObject) (gen.RestoreWorkspaceResponseObject, error) {
	restored, err := store.RestoreWorkspace(ctx, s.Pool, s.scope(ctx).OrgID, req.Id)
	if err != nil {
		return nil, err
	}
	return gen.RestoreWorkspace200JSONResponse(toWorkspace(restored)), nil
}

// PurgeWorkspace is what the maintenance does when the retention has passed,
// done now.
func (s *Server) PurgeWorkspace(ctx context.Context, req gen.PurgeWorkspaceRequestObject) (gen.PurgeWorkspaceResponseObject, error) {
	orgID := s.scope(ctx).OrgID
	purged, err := store.PurgeWorkspace(ctx, s.Pool, orgID, req.Id, 0, func(ctx context.Context) error {
		if s.Exports == nil {
			return nil // without a store for export files there are none
		}
		return s.Exports.RemoveWorkspace(ctx, orgID, req.Id)
	})
	if err != nil {
		return nil, err
	}
	for _, id := range purged.Datasources {
		s.Conns.Evict(id)
	}
	return gen.PurgeWorkspace204Response{}, nil
}
