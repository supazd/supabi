package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/authz"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/policy"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

// readPolicy turns what is stored into a policy.
func readPolicy(stored store.DatasetPolicy) (policy.Policy, error) {
	p := policy.Policy{Unmatched: stored.Unmatched, ColumnMode: stored.ColumnMode}
	if err := json.Unmarshal(stored.RowRules, &p.Rows); err != nil {
		return p, err
	}
	if err := json.Unmarshal(stored.ColumnRules, &p.Columns); err != nil {
		return p, err
	}
	return p, nil
}

// filterFits returns whether a row rule's filter still fits the dataset:
// that it compiles against the fields the dataset has now.
func filterFits(spec *dataset.Spec, d dialect.Dialect) func(dataset.Filter) bool {
	probe := query.Query{Version: query.CurrentVersion, Mode: query.ModeDetail}
	for _, f := range spec.Fields {
		if f.Role != dataset.Metric {
			probe.Columns = []query.DetailColumn{{Field: f.Key}}
			break
		}
	}
	return func(f dataset.Filter) bool {
		if !policy.HasCondition(&f) {
			return false
		}
		checked, ok := policy.CheckAttributes(f, func(field, key string) bool {
			item, exists := spec.FieldByKey(field)
			return exists && item.Type == "string" && item.Role != dataset.Metric
		})
		if !ok {
			return false
		}
		_, err := query.Compile(&probe, spec, query.Options{Dialect: d, Now: time.Now(), RowFilter: &checked, DefaultLimit: 1, MaxLimit: 1, SampleMissingParams: true})
		return err == nil
	}
}

// identityOf returns who a user is to grants and rules.
func (s *Server) identityOf(ctx context.Context, userID string) (authz.Identity, error) {
	groups, err := store.UserGroupIDs(ctx, s.Pool, s.scope(ctx).OrgID, userID)
	if err != nil {
		return authz.Identity{}, err
	}
	user, err := store.GetUser(ctx, s.Pool, s.scope(ctx).OrgID, userID)
	if err != nil {
		return authz.Identity{}, err
	}
	attrs, err := store.ListUserAttributes(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return authz.Identity{}, err
	}
	identity := authz.Identity{UserID: userID, GroupIDs: groups}
	identity.Attributes = store.AttributeValues(attrs, identity)
	identity.Attributes["userId"] = []string{userID}
	identity.Attributes["email"] = []string{user.Email}
	identity.Attributes["displayName"] = []string{user.DisplayName}
	return identity, nil
}

// dataScope is what someone may see of a dataset: the rows that pass rows
// (all of them when it is nil), and the fields other than hidden.
type dataScope struct {
	rows   *dataset.Filter
	hidden map[string]bool
}

// scopeFor returns what someone may see of a dataset. Data permissions
// restrict viewers only; a policy that cannot be read lets them see nothing.
func (s *Server) scopeFor(ctx context.Context, role authz.Role, userID, datasetID string, spec *dataset.Spec, d dialect.Dialect) (dataScope, error) {
	if role.AtLeast(authz.Developer) || datasetID == "" {
		return dataScope{}, nil
	}
	stored, err := store.GetDatasetPolicy(ctx, s.Pool, s.scope(ctx), datasetID)
	if err != nil {
		return dataScope{}, err
	}
	p, err := readPolicy(stored)
	if err != nil {
		return dataScope{rows: &policy.Nothing}, nil
	}
	id, err := s.identityOf(ctx, userID)
	if err != nil {
		return dataScope{}, err
	}
	return dataScope{rows: p.RowFilter(id, filterFits(spec, d)), hidden: p.HiddenFields(id, spec)}, nil
}

// datasetDialect returns the dialect of the database a dataset reads, without connecting to it.
func (s *Server) datasetDialect(ctx context.Context, stored store.Dataset) (dialect.Dialect, error) {
	source, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), stored.DatasourceID)
	if err != nil {
		return nil, err
	}
	driver, ok := datasource.Lookup(source.Type)
	if !ok {
		return nil, errors.New("no driver for data source type " + source.Type)
	}
	return driver.Dialect(), nil
}

func toPolicy(p policy.Policy, fits func(dataset.Filter) bool) (gen.DatasetPolicy, error) {
	mode := gen.DatasetPolicyColumnMode(p.ColumnMode)
	if mode == "" {
		mode = gen.DatasetPolicyColumnMode(policy.Visible)
	}
	out := gen.DatasetPolicy{ColumnMode: &mode, Unmatched: gen.DatasetPolicyUnmatched(p.Unmatched), Rows: []gen.RowRule{}, Columns: []gen.ColumnRule{}}
	invalid := []int{}
	for i, rule := range p.Rows {
		r := gen.RowRule{Subjects: toSubjects(rule.Subjects), Filter: map[string]any{}}
		if rule.Name != "" {
			r.Name = new(rule.Name)
		}
		if rule.Filter != nil {
			var raw map[string]any
			b, err := json.Marshal(rule.Filter)
			if err != nil {
				return out, err
			}
			if err := json.Unmarshal(b, &raw); err != nil {
				return out, err
			}
			r.Filter = raw
		}
		if !policy.HasCondition(rule.Filter) || !fits(*rule.Filter) {
			invalid = append(invalid, i)
		}
		out.Rows = append(out.Rows, r)
	}
	for _, rule := range p.Columns {
		r := gen.ColumnRule{Fields: rule.Fields, VisibleTo: toSubjects(rule.VisibleTo)}
		if rule.Name != "" {
			r.Name = new(rule.Name)
		}
		out.Columns = append(out.Columns, r)
	}
	out.InvalidRows = &invalid
	return out, nil
}

// checkPolicy reads a policy from a request and makes sure it fits the
// dataset: every rule is for someone who exists, every filter compiles, and
// every field a column rule names is the dataset's.
func (s *Server) checkPolicy(ctx context.Context, in gen.DatasetPolicy, spec *dataset.Spec, fits func(dataset.Filter) bool) (policy.Policy, error) {
	p := policy.Policy{Unmatched: string(in.Unmatched), ColumnMode: policy.Visible, Rows: []policy.RowRule{}, Columns: []policy.ColumnRule{}}
	if p.Unmatched != policy.All && p.Unmatched != policy.None {
		return p, badRequest("invalid_policy", "unmatched must be all or none")
	}
	if in.ColumnMode != nil {
		p.ColumnMode = string(*in.ColumnMode)
	}
	if p.ColumnMode != policy.Visible && p.ColumnMode != policy.Hidden {
		return p, badRequest("invalid_policy", "columnMode must be visible or hidden")
	}
	// The rule is named as people count, from 1.
	bad := func(code, kind string, i int, message string) error {
		return &apiError{status: http.StatusBadRequest, code: code, message: message, params: map[string]string{"rule": kind, "index": strconv.Itoa(i + 1)}}
	}
	attrs, err := store.ListUserAttributes(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return p, err
	}
	attributeExists := func(field, key string) bool {
		return slices.Contains(builtinAttributes, key) || slices.ContainsFunc(attrs, func(a store.UserAttribute) bool { return a.Key == key })
	}
	for i, in := range in.Rows {
		subjects, err := s.checkSubjects(ctx, in.Subjects)
		if err != nil {
			return p, err
		}
		if len(subjects) == 0 {
			return p, bad("rule_without_subjects", "row", i, "a rule names whom it is for")
		}
		rule := policy.RowRule{Subjects: subjects}
		if in.Name != nil {
			rule.Name = strings.TrimSpace(*in.Name)
		}
		if len([]rune(rule.Name)) > 100 {
			return p, badRequest("invalid_policy", "rule names must be at most 100 characters")
		}
		rule.Filter = &dataset.Filter{}
		if err := decodeStrict(in.Filter, rule.Filter, "invalid_filter"); err != nil {
			return p, err
		}
		if _, ok := policy.CheckAttributes(*rule.Filter, attributeExists); !ok {
			return p, badRequest("unknown_attribute", "the rule refers to an unknown user attribute")
		}
		if !policy.HasCondition(rule.Filter) || !fits(*rule.Filter) {
			return p, bad("invalid_rule_filter", "row", i, "a row rule requires a complete condition that fits the dataset's fields")
		}
		p.Rows = append(p.Rows, rule)
	}
	for i, in := range in.Columns {
		subjects, err := s.checkSubjects(ctx, in.VisibleTo)
		if err != nil {
			return p, err
		}
		if len(in.Fields) == 0 {
			return p, bad("rule_without_fields", "column", i, "a column rule names the fields it keeps")
		}
		for _, key := range in.Fields {
			if _, ok := spec.FieldByKey(key); !ok {
				return p, &apiError{status: http.StatusBadRequest, code: "unknown_field", message: "the dataset has no field " + key, params: map[string]string{"key": key}}
			}
		}
		rule := policy.ColumnRule{Fields: slices.Compact(slices.Clone(in.Fields)), VisibleTo: subjects}
		if in.Name != nil {
			rule.Name = strings.TrimSpace(*in.Name)
		}
		if len([]rune(rule.Name)) > 100 {
			return p, badRequest("invalid_policy", "rule names must be at most 100 characters")
		}
		p.Columns = append(p.Columns, rule)
	}
	return p, nil
}

func (s *Server) GetDatasetPolicy(ctx context.Context, req gen.GetDatasetPolicyRequestObject) (gen.GetDatasetPolicyResponseObject, error) {
	stored, spec, err := s.loadDataset(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	d, err := s.datasetDialect(ctx, stored)
	if err != nil {
		return nil, err
	}
	saved, err := store.GetDatasetPolicy(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	p, err := readPolicy(saved)
	if err != nil {
		return nil, err
	}
	attributes, err := store.ListUserAttributes(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	fits := filterFits(spec, d)
	out, err := toPolicy(p, func(f dataset.Filter) bool {
		_, ok := policy.CheckAttributes(f, func(field, key string) bool {
			return slices.Contains(builtinAttributes, key) || slices.ContainsFunc(attributes, func(a store.UserAttribute) bool { return a.Key == key })
		})
		return ok && fits(f)
	})
	out.UpdatedAt, out.UpdatedBy = saved.UpdatedAt, saved.UpdatedBy
	return gen.GetDatasetPolicy200JSONResponse(out), err
}

func (s *Server) SetDatasetPolicy(ctx context.Context, req gen.SetDatasetPolicyRequestObject) (gen.SetDatasetPolicyResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	stored, spec, err := s.loadDataset(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	d, err := s.datasetDialect(ctx, stored)
	if err != nil {
		return nil, err
	}
	fits := filterFits(spec, d)
	p, err := s.checkPolicy(ctx, *req.Body, spec, fits)
	if err != nil {
		return nil, err
	}
	rows, err := json.Marshal(p.Rows)
	if err != nil {
		return nil, err
	}
	columns, err := json.Marshal(p.Columns)
	if err != nil {
		return nil, err
	}
	if err := store.SetDatasetPolicy(ctx, s.Pool, s.scope(ctx), req.Id, store.DatasetPolicy{Unmatched: p.Unmatched, ColumnMode: p.ColumnMode, RowRules: rows, ColumnRules: columns}); err != nil {
		return nil, err
	}
	saved, err := store.GetDatasetPolicy(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	out, err := toPolicy(p, fits)
	out.UpdatedAt, out.UpdatedBy = saved.UpdatedAt, saved.UpdatedBy
	return gen.SetDatasetPolicy200JSONResponse(out), err
}

// policyPreviewRows is how many rows the preview of what someone sees shows.
const policyPreviewRows = 100

func (s *Server) PreviewDatasetPolicy(ctx context.Context, req gen.PreviewDatasetPolicyRequestObject) (gen.PreviewDatasetPolicyResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	stored, spec, err := s.loadDataset(ctx, req.Id)
	if err != nil {
		return nil, err
	}
	d, err := s.datasetDialect(ctx, stored)
	if err != nil {
		return nil, err
	}
	scope := s.scope(ctx)
	user, err := store.GetUser(ctx, s.Pool, scope.OrgID, req.Body.UserId)
	if errors.Is(err, store.ErrNotFound) {
		return nil, &apiError{status: http.StatusBadRequest, code: "unknown_user", message: "the user does not exist", params: map[string]string{"id": req.Body.UserId}}
	}
	if err != nil {
		return nil, err
	}
	role, err := store.WorkspaceRole(ctx, s.Pool, store.Principal{UserID: user.ID, OrgID: scope.OrgID, WorkspaceID: scope.WorkspaceID, IsOrgAdmin: user.IsOrgAdmin})
	if err != nil {
		return nil, err
	}
	fits := filterFits(spec, d)
	var p policy.Policy
	if req.Body.Policy != nil {
		if p, err = s.checkPolicy(ctx, *req.Body.Policy, spec, fits); err != nil {
			return nil, err
		}
	} else {
		saved, err := store.GetDatasetPolicy(ctx, s.Pool, scope, req.Id)
		if err != nil {
			return nil, err
		}
		if p, err = readPolicy(saved); err != nil {
			return nil, err
		}
	}
	out := gen.PolicyPreview{Restricted: !role.AtLeast(authz.Developer), HiddenFields: []string{}}
	var sees dataScope
	if out.Restricted {
		id, err := s.identityOf(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		sees = dataScope{rows: p.RowFilter(id, fits), hidden: p.HiddenFields(id, spec)}
	}
	limit := policyPreviewRows
	q := &query.Query{Version: query.CurrentVersion, Mode: query.ModeDetail, Limit: &limit}
	for _, f := range spec.Fields {
		switch {
		case sees.hidden[f.Key]:
			out.HiddenFields = append(out.HiddenFields, f.Key)
		case f.Role != dataset.Metric:
			q.Columns = append(q.Columns, query.DetailColumn{Field: f.Key})
		}
	}
	if len(q.Columns) == 0 {
		out.Result = gen.QueryResult{Columns: []gen.ResultColumn{}, Rows: [][]any{}}
		return gen.PreviewDatasetPolicy200JSONResponse(out), nil
	}
	if out.Result, err = s.run(ctx, stored, spec, q, sees); err != nil {
		return nil, err
	}
	return gen.PreviewDatasetPolicy200JSONResponse(out), nil
}

// checkPolicyFields refuses a change to a dataset that would delete a field
// its data permissions name: the rule would stop working, and those it covers
// would see nothing, or, for a column rule, see the field again.
func (s *Server) checkPolicyFields(ctx context.Context, datasetID string, spec *dataset.Spec) error {
	saved, err := store.GetDatasetPolicy(ctx, s.Pool, s.scope(ctx), datasetID)
	if err != nil {
		return err
	}
	p, err := readPolicy(saved)
	if err != nil {
		return err
	}
	for _, key := range p.Fields() {
		if _, ok := spec.FieldByKey(key); !ok {
			return &apiError{status: http.StatusConflict, code: "field_in_policy", message: "the field " + key + " is used by the dataset's data permissions", params: map[string]string{"key": key}}
		}
	}
	return nil
}
