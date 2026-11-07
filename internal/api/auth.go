package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/auth"
	"github.com/supazd/supabi/internal/store"
)

// The interface serves one org until multi-tenancy exists; see .agents/design/access-control.md.
const signInOrg = store.DefaultOrgID

func (s *Server) sessionInfo(ctx context.Context, principal *store.Principal) (gen.SessionInfo, error) {
	info := gen.SessionInfo{}
	if principal == nil {
		has, err := store.HasUsers(ctx, s.Pool, signInOrg)
		info.SetupRequired = !has
		return info, err
	}
	info.Authenticated = true
	info.User = &gen.SessionUser{Id: principal.UserID, Email: principal.Email, DisplayName: principal.DisplayName, IsOrgAdmin: principal.IsOrgAdmin}
	role, err := store.WorkspaceRole(ctx, s.Pool, *principal)
	if err != nil {
		return info, err
	}
	if role != "" {
		info.Role = new(gen.WorkspaceRole(role))
	}
	workspaces, err := store.ListWorkspaces(ctx, s.Pool, principal.OrgID, principal.UserID, false)
	if err != nil {
		return info, err
	}
	list := make([]gen.SessionWorkspace, len(workspaces))
	for i, w := range workspaces {
		list[i] = gen.SessionWorkspace{Id: w.ID, Name: w.Name, Timezone: w.Timezone, WeekStart: w.WeekStart, FirstWeekDays: gen.FirstWeekDays(w.FirstWeekDays)}
		if w.ID == principal.WorkspaceID {
			info.Workspace = &list[i]
		}
	}
	info.Workspaces = &list
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, principal.OrgID)
	if err != nil {
		return info, err
	}
	info.QueryRows = &gen.SessionQueryRows{Default: settings.QueryDefaultRows, Max: settings.QueryMaxRows}
	return info, nil
}

func (s *Server) GetSession(ctx context.Context, _ gen.GetSessionRequestObject) (gen.GetSessionResponseObject, error) {
	info, err := s.sessionInfo(ctx, callerFrom(ctx).principal)
	return gen.GetSession200JSONResponse(info), err
}

// signIn starts a session for the user and returns what GetSession would.
func (s *Server) signIn(ctx context.Context, u store.User) (gen.SessionInfo, error) {
	c := callerFrom(ctx)
	token, hash := auth.NewSessionToken()
	settings, err := store.SystemSettingsInForce(ctx, s.Pool, u.OrgID)
	if err != nil {
		return gen.SessionInfo{}, err
	}
	if err := store.CreateSession(ctx, s.Pool, u, hash, settings.SessionLifetime); err != nil {
		return gen.SessionInfo{}, err
	}
	setSessionCookie(c.w, c.r, token, settings.SessionLifetime)
	principal, err := store.GetPrincipal(ctx, s.Pool, hash)
	if err != nil {
		return gen.SessionInfo{}, err
	}
	return s.sessionInfo(ctx, &principal)
}

// hashPassword hashes a new password, reporting one of the wrong length as
// the caller's mistake.
func hashPassword(ctx context.Context, password string) (string, error) {
	hash, err := auth.HashPassword(ctx, password)
	if errors.Is(err, auth.ErrPasswordLength) {
		return "", badRequest("invalid_password", err.Error())
	}
	return hash, err
}

func checkNewAccount(ctx context.Context, email, displayName, password string) (string, string, string, error) {
	normalized, err := auth.NormalizeEmail(email)
	if err != nil {
		return "", "", "", badRequest("invalid_email", "enter a valid email address")
	}
	displayName = strings.TrimSpace(displayName)
	if displayName == "" {
		return "", "", "", badRequest("name_required", "name is required")
	}
	hash, err := hashPassword(ctx, password)
	if err != nil {
		return "", "", "", err
	}
	return normalized, displayName, hash, nil
}

func (s *Server) Setup(ctx context.Context, req gen.SetupRequestObject) (gen.SetupResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	email, name, hash, err := checkNewAccount(ctx, req.Body.Email, req.Body.DisplayName, req.Body.Password)
	if err != nil {
		return nil, err
	}
	user, err := store.CreateFirstAdmin(ctx, s.Pool, signInOrg, store.User{Email: email, DisplayName: name, PasswordHash: hash})
	if errors.Is(err, store.ErrConflict) {
		return nil, &apiError{status: http.StatusConflict, code: "already_set_up", message: "an administrator already exists; sign in instead"}
	}
	if err != nil {
		return nil, err
	}
	s.Logger.InfoContext(ctx, "first administrator created", "user", user.ID)
	info, err := s.signIn(ctx, user)
	if err == nil {
		e := s.event(ctx, "auth.setup", audit.Success)
		e.OrgID, e.ActorID, e.ActorEmail = signInOrg, user.ID, user.Email
		e.Object = audit.Object{Type: "user", ID: user.ID, Name: user.Email}
		s.record(ctx, e)
	}
	return gen.Setup200JSONResponse(info), err
}

func (s *Server) Login(ctx context.Context, req gen.LoginRequestObject) (gen.LoginResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	// One answer for every way of failing, so the response does not reveal
	// whether an account exists.
	rejected := &apiError{status: http.StatusUnauthorized, code: "invalid_credentials", message: "the email or password is not correct"}
	email, err := auth.NormalizeEmail(req.Body.Email)
	if err != nil {
		s.recordLogin(ctx, store.User{Email: req.Body.Email}, "unknown_account")
		return nil, rejected
	}
	// The attempt counts as a failure from before its password is checked
	// until it succeeds: .agents/design/access-control.md 13.
	allowed, err := s.Logins.Attempt(ctx, signInOrg, email)
	if err != nil {
		return nil, err
	}
	if !allowed {
		s.recordLogin(ctx, store.User{Email: email}, "too_many_attempts")
		return nil, &apiError{status: http.StatusTooManyRequests, code: "too_many_attempts", message: "too many failed attempts; try again in a few minutes"}
	}
	user, err := store.GetUserByEmail(ctx, s.Pool, signInOrg, email)
	switch {
	case errors.Is(err, store.ErrNotFound):
		if err := auth.VerifyAgainstNothing(ctx, req.Body.Password); err != nil {
			return nil, err
		}
		s.recordLogin(ctx, store.User{Email: email}, "unknown_account")
		return nil, rejected
	case err != nil:
		return nil, err
	}
	// The audit tells the reasons apart; the response must not.
	ok, err := auth.VerifyPassword(ctx, user.PasswordHash, req.Body.Password)
	if err != nil {
		return nil, err
	}
	if !ok {
		s.recordLogin(ctx, user, "wrong_password")
		return nil, rejected
	}
	if user.Status != store.UserActive {
		s.recordLogin(ctx, user, "disabled")
		return nil, rejected
	}
	if err := s.Logins.Succeed(ctx, signInOrg, email); err != nil {
		return nil, err
	}
	info, err := s.signIn(ctx, user)
	if err == nil {
		s.recordLogin(ctx, user, "")
	}
	return gen.Login200JSONResponse(info), err
}

func (s *Server) Logout(ctx context.Context, _ gen.LogoutRequestObject) (gen.LogoutResponseObject, error) {
	c := callerFrom(ctx)
	if c.tokenHash != nil {
		if err := store.DeleteSession(ctx, s.Pool, c.tokenHash); err != nil {
			return nil, err
		}
	}
	setSessionCookie(c.w, c.r, "", 0)
	return gen.Logout204Response{}, nil
}

func (s *Server) ChangePassword(ctx context.Context, req gen.ChangePasswordRequestObject) (gen.ChangePasswordResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	c := callerFrom(ctx)
	current, err := store.GetUserPasswordHash(ctx, s.Pool, c.principal.OrgID, c.principal.UserID)
	if err != nil {
		return nil, err
	}
	ok, err := auth.VerifyPassword(ctx, current, req.Body.CurrentPassword)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, badRequest("wrong_password", "the current password is not correct")
	}
	hash, err := hashPassword(ctx, req.Body.NewPassword)
	if err != nil {
		return nil, err
	}
	if err := store.SetPassword(ctx, s.Pool, c.principal.OrgID, c.principal.UserID, hash, c.tokenHash); err != nil {
		return nil, err
	}
	return gen.ChangePassword204Response{}, nil
}

func (s *Server) SwitchWorkspace(ctx context.Context, req gen.SwitchWorkspaceRequestObject) (gen.SwitchWorkspaceResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	c := callerFrom(ctx)
	if err := store.SwitchWorkspace(ctx, s.Pool, c.tokenHash, req.Body.WorkspaceId); err != nil {
		return nil, err
	}
	principal, err := store.GetPrincipal(ctx, s.Pool, c.tokenHash)
	if err != nil {
		return nil, err
	}
	info, err := s.sessionInfo(ctx, &principal)
	return gen.SwitchWorkspace200JSONResponse(info), err
}
