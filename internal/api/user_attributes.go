package api

import (
	"context"
	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/store"
	"regexp"
	"slices"
	"strings"
)

var attributeKey = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_]{0,63}$`)
var builtinAttributes = []string{"userId", "email", "displayName"}

func toUserAttribute(a store.UserAttribute) gen.UserAttribute {
	out := gen.UserAttribute{Key: a.Key, Name: a.Name, Assignments: []gen.AttributeAssignment{}}
	for _, v := range a.Assignments {
		out.Assignments = append(out.Assignments, gen.AttributeAssignment{Subject: toSubject(v.Subject), Values: v.Values})
	}
	return out
}

func (s *Server) ListUserAttributes(ctx context.Context, _ gen.ListUserAttributesRequestObject) (gen.ListUserAttributesResponseObject, error) {
	attrs, err := store.ListUserAttributes(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := gen.ListUserAttributes200JSONResponse{}
	for _, key := range builtinAttributes {
		out = append(out, gen.UserAttribute{Key: key, Name: key, Builtin: true, Assignments: []gen.AttributeAssignment{}})
	}
	for _, a := range attrs {
		out = append(out, toUserAttribute(a))
	}
	return out, nil
}

func (s *Server) SetUserAttribute(ctx context.Context, req gen.SetUserAttributeRequestObject) (gen.SetUserAttributeResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if !attributeKey.MatchString(req.Key) || slices.Contains(builtinAttributes, req.Key) {
		return nil, badRequest("invalid_attribute_key", "use a unique key, beginning with a letter, up to 64 letters, digits or underscores; built-in keys are reserved")
	}
	a := store.UserAttribute{Key: req.Key, Name: strings.TrimSpace(req.Body.Name), Assignments: []store.AttributeAssignment{}}
	if a.Name == "" || len([]rune(a.Name)) > 100 || len(req.Body.Assignments) > 10000 {
		return nil, badRequest("invalid_attribute", "an attribute needs a name and at most 10000 assignments")
	}
	// Validate the whole directory batch once, rather than loading it per assignment.
	subjects := make([]gen.Subject, len(req.Body.Assignments))
	for i, assignment := range req.Body.Assignments {
		subjects[i] = assignment.Subject
	}
	if _, err := s.checkSubjects(ctx, subjects); err != nil {
		return nil, err
	}
	seen := map[authz.Subject]bool{}
	for _, v := range req.Body.Assignments {
		sub := authz.Subject{}
		if v.Subject.User != nil {
			sub.UserID = *v.Subject.User
		}
		if v.Subject.Group != nil {
			sub.GroupID = *v.Subject.Group
		}
		sub.Everyone = v.Subject.Everyone != nil && *v.Subject.Everyone
		if sub.Everyone || seen[sub] || len(v.Values) > 500 {
			return nil, badRequest("invalid_attribute", "assign each user or group once, with at most 500 values")
		}
		seen[sub] = true
		values := []string{}
		for _, value := range v.Values {
			if strings.TrimSpace(value) == "" || len(value) > 1000 {
				return nil, badRequest("invalid_attribute", "attribute values must be nonempty text up to 1000 bytes")
			}
			if !slices.Contains(values, value) {
				values = append(values, value)
			}
		}
		a.Assignments = append(a.Assignments, store.AttributeAssignment{Subject: sub, Values: values})
	}
	if err := store.SetUserAttribute(ctx, s.Pool, s.scope(ctx), a); err != nil {
		return nil, err
	}
	return gen.SetUserAttribute200JSONResponse(toUserAttribute(a)), nil
}

func (s *Server) DeleteUserAttribute(ctx context.Context, req gen.DeleteUserAttributeRequestObject) (gen.DeleteUserAttributeResponseObject, error) {
	if slices.Contains(builtinAttributes, req.Key) {
		return nil, badRequest("invalid_attribute_key", "built-in attributes cannot be deleted")
	}
	if err := store.DeleteUserAttribute(ctx, s.Pool, s.scope(ctx), req.Key); err != nil {
		return nil, err
	}
	return gen.DeleteUserAttribute204Response{}, nil
}
