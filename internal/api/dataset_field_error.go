package api

import (
	"context"
	"encoding/json"
	"errors"
	"maps"
	"strings"

	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/store"
)

// datasetFieldError gives a deleted field its last saved label, so an author
// can find and repair the broken reference. Looking up history is best effort:
// failure must not hide the original query error or expose a restricted label.
func (s *Server) datasetFieldError(ctx context.Context, datasetID string, err error) error {
	var problem *dataset.Error
	if !errors.As(err, &problem) || problem.Code != "unknown_field" || problem.Params["key"] == "" || problem.Params["label"] != "" {
		return err
	}
	// Dashboard binding validation can fail before a query is associated with
	// one widget. The content layer identifies the saved chart's dataset then.
	if datasetID == "" {
		datasetID = problem.Params["dataset"]
	}
	if datasetID == "" {
		return err
	}
	raw, historyErr := store.DatasetRevisionWithField(ctx, s.Pool, s.scope(ctx), datasetID, problem.Params["key"])
	if historyErr != nil {
		return err
	}
	var spec dataset.Spec
	if json.Unmarshal(raw, &spec) != nil {
		return err
	}
	field, exists := spec.FieldByKey(problem.Params["key"])
	if !exists || strings.TrimSpace(field.Label) == "" {
		return err
	}
	if c := callerFrom(ctx); !c.role.AtLeast(authz.Developer) {
		stored, policyErr := store.GetDatasetPolicy(ctx, s.Pool, s.scope(ctx), datasetID)
		if policyErr != nil {
			return err
		}
		p, policyErr := readPolicy(stored)
		if policyErr != nil {
			return err
		}
		identity, identityErr := s.identityOf(ctx, c.principal.UserID)
		if identityErr != nil || p.HiddenFields(identity, &spec)[field.Key] {
			return err
		}
	}
	out := *problem
	out.Params = maps.Clone(problem.Params)
	out.Params["label"] = field.Label
	return &out
}
