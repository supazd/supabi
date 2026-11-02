package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"slices"
	"strings"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/content"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/store"
)

func checkDatasetRevision(expected int, current store.Dataset) error {
	if expected != current.Revision {
		return store.ErrRevisionConflict
	}
	return nil
}

func requireRevision(revision int) error {
	if revision < 1 {
		return badRequest("revision_required", "expectedRevision must be a positive content revision")
	}
	return nil
}

func (s *Server) AnalyzeDatasetImpact(ctx context.Context, req gen.AnalyzeDatasetImpactRequestObject) (gen.AnalyzeDatasetImpactResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	if err := requireRevision(req.Body.ExpectedRevision); err != nil {
		return nil, err
	}
	input := datasetUpdateInput(req.Body)
	current, err := store.GetDataset(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if err := checkDatasetRevision(req.Body.ExpectedRevision, current); err != nil {
		return nil, err
	}
	var spec dataset.Spec
	if err := decodeStrict(req.Body.Spec, &spec, "invalid_spec"); err != nil {
		return nil, err
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	if err := s.checkPolicyFields(ctx, req.Id, &spec); err != nil {
		return nil, err
	}
	charts, dashboards, err := store.DatasetReaders(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	impact, err := analyzeDatasetImpact(current, input, &spec, charts, dashboards)
	return gen.AnalyzeDatasetImpact200JSONResponse(impact), err
}

// A confirmation names the proposal, its base revision and every reader's
// definition. Opening a reader in another tab and fixing it invalidates the
// previous confirmation; a second save must show the new impact.
func analyzeDatasetImpact(current store.Dataset, input *gen.DatasetInput, next *dataset.Spec, charts []store.Chart, dashboards []store.Dashboard) (gen.DatasetImpact, error) {
	out := gen.DatasetImpact{Revision: current.Revision, Changes: []gen.DatasetChange{}, Charts: []gen.DatasetImpactChart{}, Dashboards: []gen.DatasetImpactDashboard{}}
	var old dataset.Spec
	if err := json.Unmarshal(current.Spec, &old); err != nil {
		return out, err
	}
	out.Changes = datasetChanges(&old, next)
	chartSpecs := map[string]content.ChartSpec{}
	chartChanges := map[string][]int{}
	for _, chart := range charts {
		var spec content.ChartSpec
		if err := json.Unmarshal(chart.Spec, &spec); err != nil {
			return out, err
		}
		chartSpecs[chart.ID] = spec
		refs := chartFieldRefs(&spec)
		chartChanges[chart.ID] = affectedChanges(out.Changes, refs, chartParamRefs(&spec), &old, next)
	}
	allChartChanges := maps.Clone(chartChanges)
	for _, board := range dashboards {
		var spec content.DashboardSpec
		if err := json.Unmarshal(board.Spec, &spec); err != nil {
			return out, err
		}
		hit := gen.DatasetImpactDashboard{Id: board.ID, Name: board.Name, ChartIds: []string{}, ChangeIndexes: []int{}}
		for _, item := range spec.Widgets() {
			_, ok := chartSpecs[item.ChartID]
			if !ok || item.Type != "chart" {
				continue
			}
			refs := map[string]bool{}
			for _, filter := range spec.Filters {
				for _, target := range filter.Targets {
					if target.Item == item.ID {
						refs[target.Field] = true
					}
				}
			}
			for _, link := range spec.Links {
				for _, target := range link.Targets {
					if target.Item == item.ID {
						refs[target.Field] = true
					}
				}
			}
			// Global measure targets and legacy filter bindings ultimately refer to
			// chart fields, already included by chartFieldRefs.
			indexes := unionIndexes(chartChanges[item.ChartID], affectedChanges(out.Changes, refs, nil, &old, next))
			if len(indexes) == 0 {
				continue
			}
			if !slices.Contains(hit.ChartIds, item.ChartID) {
				hit.ChartIds = append(hit.ChartIds, item.ChartID)
			}
			hit.ChangeIndexes = unionIndexes(hit.ChangeIndexes, indexes)
			// A chart affected only under a dashboard filter still belongs in the
			// affected chart list, so the user has somewhere to inspect the binding.
			allChartChanges[item.ChartID] = unionIndexes(allChartChanges[item.ChartID], indexes)
		}
		if len(hit.ChangeIndexes) > 0 {
			out.Dashboards = append(out.Dashboards, hit)
		}
	}
	for _, chart := range charts {
		if indexes := allChartChanges[chart.ID]; len(indexes) > 0 {
			out.Charts = append(out.Charts, gen.DatasetImpactChart{Id: chart.ID, Name: chart.Name, ChangeIndexes: indexes})
		}
	}
	// Ignore confirmation metadata and encode the parsed spec canonically, as
	// validation does on the save path. A token is an acknowledgement, not a
	// permission: the normal developer and policy checks always apply.
	proposal := *input
	proposal.ImpactToken = nil
	proposal.Name = strings.TrimSpace(proposal.Name)
	rawSpec, err := json.Marshal(next)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(rawSpec, &proposal.Spec); err != nil {
		return out, err
	}
	raw, err := json.Marshal(struct {
		ID         string
		Revision   int
		Proposal   gen.DatasetInput
		Charts     []store.Chart
		Dashboards []store.Dashboard
	}{current.ID, current.Revision, proposal, charts, dashboards})
	if err != nil {
		return out, err
	}
	hash := sha256.Sum256(raw)
	out.ConfirmationToken = hex.EncodeToString(hash[:])
	return out, nil
}

func datasetChanges(old, next *dataset.Spec) []gen.DatasetChange {
	changes := []gen.DatasetChange{}
	add := func(kind, key, label, reason string) {
		if label == "" {
			label = key
		}
		changes = append(changes, gen.DatasetChange{Kind: gen.DatasetChangeKind(kind), Key: key, Label: label, Reason: gen.DatasetChangeReason(reason)})
	}
	for _, before := range old.Fields {
		after, ok := next.FieldByKey(before.Key)
		if !ok {
			add("field", before.Key, before.Label, "removed")
			continue
		}
		if before.Type != after.Type {
			add("field", before.Key, before.Label, "type_changed")
		}
		if before.Role != after.Role {
			add("field", before.Key, before.Label, "role_changed")
		}
	}
	beforeRequired, afterRequired := old.ParamsRequiringInput(true), next.ParamsRequiringInput(true)
	beforeEmpty, afterEmpty := old.ParamsRequiringInput(false), next.ParamsRequiringInput(false)
	for _, before := range old.Params {
		after, ok := next.ParamByName(before.Name)
		if !ok {
			add("parameter", before.Name, before.Label, "removed")
			continue
		}
		if before.Type != after.Type {
			add("parameter", before.Name, before.Label, "type_changed")
		}
		if before.Multi != after.Multi {
			add("parameter", before.Name, before.Label, "multi_changed")
		}
		// A viewer clearing a parameter's control gives it no value, bypassing
		// the default. A Required flag or moving out of [[ ]] can make that
		// choice invalid.
		rejectsEmpty := afterEmpty[after.Name] && !beforeEmpty[before.Name]
		if afterRequired[after.Name] && !beforeRequired[before.Name] || rejectsEmpty {
			add("parameter", before.Name, before.Label, "required")
		}
	}
	for _, after := range next.Params {
		if _, ok := old.ParamByName(after.Name); !ok && afterRequired[after.Name] {
			add("parameter", after.Name, after.Label, "required")
		}
	}
	return changes
}

// chartParamRefs are the parameters a chart gives values: through its
// parameter filters, or fixed in its query.
func chartParamRefs(chart *content.ChartSpec) map[string]bool {
	refs := map[string]bool{}
	for name := range chart.Query.Params {
		refs[name] = true
	}
	for _, f := range chart.Filters {
		if f.IsParam() {
			refs[f.Param] = true
		}
	}
	return refs
}

func chartFieldRefs(chart *content.ChartSpec) map[string]bool {
	refs := map[string]bool{}
	aliases := map[string]string{}
	q := &chart.Query
	for _, d := range q.Dimensions {
		refs[d.Field] = true
		aliases[d.Name()] = d.Field
	}
	for _, c := range q.Columns {
		refs[c.Field] = true
	}
	for _, list := range [][]query.Measure{q.Measures, q.FilterMeasures} {
		for _, m := range list {
			refs[m.Field] = true
			aliases[m.Name()] = m.Field
			if m.Compute != nil {
				refs[m.Compute.TimeField] = true
			}
		}
	}
	var filter func(*dataset.Filter)
	filter = func(f *dataset.Filter) {
		if f == nil {
			return
		}
		if f.Field != "" {
			field := f.Field
			if alias, ok := aliases[field]; ok {
				refs[alias] = true
			}
			refs[field] = true
		}
		for i := range f.Args {
			filter(&f.Args[i])
		}
	}
	filter(q.Filter)
	filter(q.Having)
	for _, f := range chart.Filters {
		refs[f.Field] = true
	}
	for _, d := range chart.Dynamics {
		for _, option := range d.Options {
			refs[option.Field] = true
		}
	}
	if chart.Drill != nil {
		for _, level := range chart.Drill.Levels {
			refs[level.Field] = true
		}
	}
	return refs
}

// affectedChanges returns the changes that touch a chart using the fields
// refs and the parameters params. A parameter's removal or new type matters
// only to charts giving it a value; one coming to need a value it lacked
// matters to every chart. A nil params leaves parameters out, for references
// made by a dashboard rather than by its charts.
func affectedChanges(changes []gen.DatasetChange, refs, params map[string]bool, old, next *dataset.Spec) []int {
	// Include expression dependencies before and after the edit. In particular,
	// a chart may use a metric that depends on the changed row-level field.
	expanded := map[string]bool{}
	var visit func(string)
	visit = func(key string) {
		if key == "" || expanded[key] {
			return
		}
		expanded[key] = true
		for _, spec := range []*dataset.Spec{old, next} {
			if field, ok := spec.FieldByKey(key); ok {
				for _, ref := range field.Refs() {
					visit(ref)
				}
			}
		}
	}
	for key := range refs {
		visit(key)
	}
	indexes := []int{}
	for i, change := range changes {
		parameter := change.Kind == "parameter" && params != nil && (change.Reason == "required" || params[change.Key])
		if parameter || change.Kind == "field" && expanded[change.Key] {
			indexes = append(indexes, i)
		}
	}
	return indexes
}

func unionIndexes(a, b []int) []int {
	out := slices.Clone(a)
	for _, i := range b {
		if !slices.Contains(out, i) {
			out = append(out, i)
		}
	}
	slices.Sort(out)
	return out
}
