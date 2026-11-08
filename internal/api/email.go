package api

import (
	"context"
	"errors"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/audit"
	"github.com/supazd/supabi/internal/i18n"
	"github.com/supazd/supabi/internal/mail"
	"github.com/supazd/supabi/internal/store"
)

// The SMTP server the organization sends email through, and a test email
// to check it with: .agents/design/email.md.

// maxFromName keeps the sender's name to what a mail client shows.
const maxFromName = 100

// hostPattern is a host name; an IP address is checked apart.
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9_]([A-Za-z0-9_.-]*[A-Za-z0-9_])?$`)

func (s *Server) GetEmailSettings(ctx context.Context, _ gen.GetEmailSettingsRequestObject) (gen.GetEmailSettingsResponseObject, error) {
	v, err := store.GetEmailSettings(ctx, s.Pool, s.scope(ctx).OrgID)
	if err != nil {
		return nil, err
	}
	return gen.GetEmailSettings200JSONResponse(emailSettingsResponse(v)), nil
}

// SetEmailSettings records the settings before and after, without the
// password: only whether it changed.
func (s *Server) SetEmailSettings(ctx context.Context, req gen.SetEmailSettingsRequestObject) (gen.SetEmailSettingsResponseObject, error) {
	sc := s.scope(ctx)
	before, err := store.GetEmailSettings(ctx, s.Pool, sc.OrgID)
	if err != nil {
		return nil, err
	}
	v, keepPassword, err := s.emailInput(req.Body, before)
	if err != nil {
		return nil, err
	}
	if err := store.SetEmailSettings(ctx, s.Pool, sc, v, keepPassword); err != nil {
		return nil, err
	}
	after, err := store.GetEmailSettings(ctx, s.Pool, sc.OrgID)
	if err != nil {
		return nil, err
	}
	e := s.event(ctx, "email_settings.update", audit.Success)
	e.Detail = map[string]any{"before": emailDetail(before), "after": emailDetail(after),
		"passwordChanged": !keepPassword && (len(before.Password) > 0 || len(after.Password) > 0)}
	s.record(ctx, e)
	return gen.SetEmailSettings200JSONResponse(emailSettingsResponse(after)), nil
}

// TestEmailSettings sends with the settings in the form, saved or not. A
// failure to send is an answer, not an error: the administrator needs the
// server's words to fix the settings.
func (s *Server) TestEmailSettings(ctx context.Context, req gen.TestEmailSettingsRequestObject) (gen.TestEmailSettingsResponseObject, error) {
	in := req.Body
	if in == nil {
		return nil, badRequest("invalid_request", "a body is required")
	}
	sc := s.scope(ctx)
	stored, err := store.GetEmailSettings(ctx, s.Pool, sc.OrgID)
	if err != nil {
		return nil, err
	}
	v, keepPassword, err := s.emailInput(&in.Settings, stored)
	if err != nil {
		return nil, err
	}
	if v.Host == "" {
		return nil, badRequest("email_host_required", "a server is needed to send a test")
	}
	to, ok := mail.ParseAddress(in.To)
	if !ok {
		return nil, emailAddressError("to")
	}
	locale := string(in.Locale)
	if !slices.Contains(i18n.Locales, locale) {
		return nil, badRequest("invalid_locale", "unknown language")
	}
	if keepPassword && v.Username != "" {
		v.Password = stored.Password
	}
	server, err := mail.ServerOf(v, s.Secrets)
	if err != nil {
		return nil, err
	}
	p := callerFrom(ctx).principal
	message := mail.Message{To: []string{to}, Subject: i18n.T(locale, "email.test.subject", nil), Text: i18n.T(locale, "email.test.body", map[string]string{
		"name": p.DisplayName, "email": p.Email, "server": server.Addr(), "security": i18n.T(locale, "email.security."+server.Security, nil),
	})}
	start := time.Now()
	err = mail.Send(ctx, server, message)
	out := gen.EmailTest{Ok: err == nil, DurationMs: int(time.Since(start).Milliseconds())}
	e := s.event(ctx, "email.test", audit.Success)
	e.Detail = map[string]any{"to": to, "server": server.Addr(), "security": server.Security}
	if err != nil {
		var failure *mail.Error
		if !errors.As(err, &failure) {
			return nil, err
		}
		stage, reason := gen.EmailFailureStage(failure.Stage), failure.Reason()
		out.Stage, out.Message = &stage, &reason
		e.Outcome = audit.Failure
		e.Detail["stage"], e.Detail["error"] = string(failure.Stage), reason
	}
	s.record(ctx, e)
	return gen.TestEmailSettings200JSONResponse(out), nil
}

// emailInput checks settings as a form sent them, against those stored. It
// returns them with a new password sealed, and whether to keep the stored
// password instead.
func (s *Server) emailInput(in *gen.EmailSettingsInput, stored store.EmailSettings) (store.EmailSettings, bool, error) {
	if in == nil {
		return store.EmailSettings{}, false, badRequest("invalid_request", "a body is required")
	}
	trimmed := func(p *string) string {
		if p == nil {
			return ""
		}
		return strings.TrimSpace(*p)
	}
	v := store.EmailSettings{Host: trimmed(in.Host), Security: string(in.Security), Username: trimmed(in.Username),
		FromAddress: trimmed(in.FromAddress), FromName: trimmed(in.FromName)}
	if in.Port != nil {
		v.Port = *in.Port
		if v.Port < 1 || v.Port > 65535 {
			return v, false, &apiError{status: 400, code: "invalid_setting", message: "port must be between 1 and 65535",
				params: map[string]string{"setting": "port", "min": "1", "max": "65535"}}
		}
	}
	if !slices.Contains(mail.Securities, v.Security) {
		return v, false, badRequest("invalid_email_security", "the encryption must be starttls, tls or none")
	}
	if v.Host != "" && !validHost(v.Host) {
		return v, false, badRequest("invalid_email_host", "the server must be a host name or an IP address, without a scheme or port")
	}
	if v.FromAddress != "" {
		address, ok := mail.ParseAddress(v.FromAddress)
		if !ok {
			return v, false, emailAddressError("fromAddress")
		}
		v.FromAddress = address
	}
	if v.Host != "" && v.FromAddress == "" {
		return v, false, badRequest("email_from_required", "a sender address is required with a server")
	}
	if utf8.RuneCountInString(v.FromName) > maxFromName || strings.ContainsFunc(v.FromName, unicode.IsControl) {
		return v, false, badRequest("invalid_email_from_name", "the sender name must be at most "+strconv.Itoa(maxFromName)+" characters, on one line")
	}
	keepPassword := in.Password == nil
	if in.Password != nil && *in.Password != "" {
		v.Password = s.Secrets.Seal(*in.Password)
	}
	// Without a username there is nothing to sign in as.
	if v.Username == "" {
		keepPassword, v.Password = false, nil
	}
	if v.Security == mail.None && v.Username != "" {
		return v, false, badRequest("email_auth_unencrypted", "without encryption the server is used without signing in, so that no password goes out in plain text")
	}
	if v.Username != "" && len(v.Password) == 0 && !(keepPassword && len(stored.Password) > 0) {
		return v, false, badRequest("email_password_required", "a password is required with a username")
	}
	return v, keepPassword, nil
}

func validHost(host string) bool {
	return len(host) <= 253 && (hostPattern.MatchString(host) || net.ParseIP(host) != nil)
}

func emailAddressError(field string) error {
	return &apiError{status: 400, code: "invalid_email_address", message: field + " must be an address such as bi@example.com",
		params: map[string]string{"field": field}}
}

func emailSettingsResponse(v store.EmailSettings) gen.EmailSettings {
	out := gen.EmailSettings{Host: optional(v.Host), Security: gen.EmailSecurity(v.Security), Username: optional(v.Username),
		HasPassword: len(v.Password) > 0, FromAddress: optional(v.FromAddress), FromName: optional(v.FromName)}
	if v.Port != 0 {
		out.Port = &v.Port
	}
	out.Defaults.FromName = mail.DefaultFromName
	out.Defaults.Ports.Starttls, out.Defaults.Ports.Tls, out.Defaults.Ports.None = mail.DefaultPorts[mail.StartTLS], mail.DefaultPorts[mail.TLS], mail.DefaultPorts[mail.None]
	return out
}

// emailDetail is what the audit keeps of the settings: all but the password.
func emailDetail(v store.EmailSettings) map[string]any {
	return map[string]any{"host": v.Host, "port": v.Port, "security": v.Security, "username": v.Username,
		"hasPassword": len(v.Password) > 0, "fromAddress": v.FromAddress, "fromName": v.FromName}
}
