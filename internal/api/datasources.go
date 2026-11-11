package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/api/gen"
	"github.com/supazd/supabi/internal/dataset"
	"github.com/supazd/supabi/internal/datasource"
	"github.com/supazd/supabi/internal/dialect"
	"github.com/supazd/supabi/internal/expr"
	"github.com/supazd/supabi/internal/query"
	"github.com/supazd/supabi/internal/source"
	"github.com/supazd/supabi/internal/store"
)

func (s *Server) ListDatasourceTypes(context.Context, gen.ListDatasourceTypesRequestObject) (gen.ListDatasourceTypesResponseObject, error) {
	out := gen.ListDatasourceTypes200JSONResponse{}
	for _, d := range datasource.Drivers() {
		if datasource.Builtin(d) {
			continue // created by the system, not offered in the form
		}
		t := gen.DatasourceType{Name: d.Name(), Category: gen.DatasourceTypeCategory(d.Category()), Settings: []gen.SettingField{}}
		for _, f := range d.Settings() {
			field := gen.SettingField{Name: f.Name, Required: f.Required}
			if f.Default != "" {
				field.Default = &f.Default
			}
			if len(f.Options) > 0 {
				field.Options = &f.Options
			}
			t.Settings = append(t.Settings, field)
		}
		out = append(out, t)
	}
	return out, nil
}

func toDatasource(d store.Datasource) gen.Datasource {
	return gen.Datasource{
		Id: d.ID, Name: d.Name, Type: d.Type, Settings: d.Settings, DataTimezone: d.DataTimezone,
		HasPassword: len(d.Secret) > 0, CacheTtlSeconds: d.CacheTTLSeconds, MaxConcurrentQueries: d.MaxConcurrentQueries,
		CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt,
	}
}

// checkDatasourceInput validates the input and returns what would be stored
// (without the password) together with the connection config.
func (s *Server) checkDatasourceInput(in *gen.DatasourceInput) (store.Datasource, datasource.Config, error) {
	var none store.Datasource
	if in == nil {
		return none, datasource.Config{}, badRequest("invalid_request", "a request body is required")
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return none, datasource.Config{}, badRequest("name_required", "name is required")
	}
	driver, ok := datasource.Lookup(in.Type)
	if !ok || datasource.Builtin(driver) {
		return none, datasource.Config{}, &apiError{status: 400, code: "unknown_datasource_type", message: "unknown data source type " + in.Type, params: map[string]string{"type": in.Type}}
	}
	settings, err := datasource.CheckSettings(driver, in.Settings)
	if err != nil {
		return none, datasource.Config{}, badRequest("invalid_settings", err.Error())
	}
	zone := "UTC"
	if in.DataTimezone != nil && *in.DataTimezone != "" {
		zone = *in.DataTimezone
	}
	if _, err := time.LoadLocation(zone); err != nil || zone == "Local" {
		return none, datasource.Config{}, &apiError{status: 400, code: "invalid_timezone", message: "unknown time zone " + zone, params: map[string]string{"timezone": zone}}
	}
	if ttl := in.CacheTtlSeconds; ttl != nil && *ttl != 0 && (*ttl < 60 || *ttl > 86400) {
		return none, datasource.Config{}, badRequest("invalid_cache_ttl", "results are kept for 0 seconds (not at all) or between 60 and 86400 seconds")
	}
	if n := in.MaxConcurrentQueries; n != nil && (*n < 1 || *n > 64) {
		return none, datasource.Config{}, badRequest("invalid_max_concurrent_queries", "between 1 and 64 queries can run at once")
	}
	password := ""
	if in.Password != nil {
		password = *in.Password
	}
	return store.Datasource{Name: name, Type: in.Type, Settings: settings, DataTimezone: zone, CacheTTLSeconds: in.CacheTtlSeconds, MaxConcurrentQueries: in.MaxConcurrentQueries},
		datasource.Config{Settings: settings, Password: password, DataTimezone: zone}, nil
}

func (s *Server) ListDatasources(ctx context.Context, _ gen.ListDatasourcesRequestObject) (gen.ListDatasourcesResponseObject, error) {
	list, err := store.ListDatasources(ctx, s.Pool, s.scope(ctx))
	if err != nil {
		return nil, err
	}
	out := make(gen.ListDatasources200JSONResponse, len(list))
	for i, d := range list {
		out[i] = toDatasource(d)
	}
	return out, nil
}

func (s *Server) CreateDatasource(ctx context.Context, req gen.CreateDatasourceRequestObject) (gen.CreateDatasourceResponseObject, error) {
	d, cfg, err := s.checkDatasourceInput(req.Body)
	if err != nil {
		return nil, err
	}
	if cfg.Password != "" {
		d.Secret = s.Secrets.Seal(cfg.Password)
	}
	created, err := store.CreateDatasource(ctx, s.Pool, s.scope(ctx), d)
	if err != nil {
		return nil, err
	}
	return gen.CreateDatasource201JSONResponse(toDatasource(created)), nil
}

func (s *Server) TestDatasource(ctx context.Context, req gen.TestDatasourceRequestObject) (gen.TestDatasourceResponseObject, error) {
	d, cfg, err := s.checkDatasourceInput(req.Body)
	if err != nil {
		return nil, err
	}
	return gen.TestDatasource200JSONResponse(attempt(ctx, d.Type, cfg)), nil
}

// attempt tries to connect and reports how it went. A failure to connect is
// an answer, not an error: the message describes the user's own database, and
// they need it to fix the settings.
func attempt(ctx context.Context, driver string, cfg datasource.Config) gen.ConnectionTest {
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := datasource.Open(ctx, driver, cfg)
	if err == nil {
		defer conn.Close()
		err = conn.Ping(ctx)
	}
	if err != nil {
		return failedTest(err)
	}
	return gen.ConnectionTest{Ok: true}
}

// failedTest reports a failed attempt to connect. One the driver recognises,
// such as a server too old, also carries a code to explain it by.
func failedTest(err error) gen.ConnectionTest {
	message := err.Error()
	out := gen.ConnectionTest{Ok: false, Message: &message}
	var known *datasource.ConnectError
	if errors.As(err, &known) {
		code := gen.ConnectionTestCode(known.Code)
		out.Code = &code
		if len(known.Params) > 0 {
			out.Params = &known.Params
		}
	}
	return out
}

// changed is a stored data source as the input would leave it, with the
// config to connect that way. The type stays, and so does the password when
// the input has none: it is never sent back to be sent in again. It stays
// only while the connection goes to the same server in the same way, so that
// it cannot be had by pointing the data source somewhere else.
func (s *Server) changed(existing store.Datasource, in *gen.DatasourceInput) (store.Datasource, datasource.Config, error) {
	d, cfg, err := s.checkDatasourceInput(in)
	if err != nil {
		return existing, cfg, err
	}
	if d.Type != existing.Type {
		return existing, cfg, badRequest("datasource_type_fixed", "the type of a data source cannot be changed")
	}
	d.ID, d.Secret = existing.ID, existing.Secret
	if cfg.Password != "" {
		d.Secret = s.Secrets.Seal(cfg.Password)
	} else if len(existing.Secret) > 0 {
		// The stored password goes only where it was stored for. The driver
		// is known: checkDatasourceInput has looked it up.
		if driver, _ := datasource.Lookup(d.Type); !datasource.SameTarget(driver, existing.Settings, d.Settings) {
			return existing, cfg, badRequest("datasource_password_required", "the password is needed again when the server, the user or the encryption changes")
		}
		if cfg.Password, err = s.Secrets.Open(existing.Secret); err != nil {
			return existing, cfg, err
		}
	}
	return d, cfg, nil
}

func (s *Server) UpdateDatasource(ctx context.Context, req gen.UpdateDatasourceRequestObject) (gen.UpdateDatasourceResponseObject, error) {
	existing, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	d, _, err := s.changed(existing, req.Body)
	if err != nil {
		return nil, err
	}
	updated, err := store.UpdateDatasource(ctx, s.Pool, s.scope(ctx), d)
	if err != nil {
		return nil, err
	}
	s.Conns.Evict(req.Id)
	return gen.UpdateDatasource200JSONResponse(toDatasource(updated)), nil
}

func (s *Server) TestStoredDatasource(ctx context.Context, req gen.TestStoredDatasourceRequestObject) (gen.TestStoredDatasourceResponseObject, error) {
	existing, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	if req.Body != nil {
		_, cfg, err := s.changed(existing, req.Body)
		if err != nil {
			return nil, err
		}
		return gen.TestStoredDatasource200JSONResponse(attempt(ctx, existing.Type, cfg)), nil
	}
	// As saved: the connection everything else reads through is the one to try.
	ctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	conn, err := s.connect(ctx, existing)
	if err == nil {
		err = conn.Ping(ctx)
	}
	if err != nil {
		return gen.TestStoredDatasource200JSONResponse(failedTest(err)), nil
	}
	return gen.TestStoredDatasource200JSONResponse{Ok: true}, nil
}

func (s *Server) GetDatasource(ctx context.Context, req gen.GetDatasourceRequestObject) (gen.GetDatasourceResponseObject, error) {
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	return gen.GetDatasource200JSONResponse(toDatasource(d)), nil
}

func (s *Server) DeleteDatasource(ctx context.Context, req gen.DeleteDatasourceRequestObject) (gen.DeleteDatasourceResponseObject, error) {
	if err := store.DeleteDatasource(ctx, s.Pool, s.scope(ctx), req.Id); err != nil {
		return nil, err
	}
	s.Conns.Evict(req.Id)
	return gen.DeleteDatasource204Response{}, nil
}

// connect returns the pooled connection of a stored data source.
func (s *Server) connect(ctx context.Context, d store.Datasource) (datasource.Conn, error) {
	return (source.Connections{Pool: s.Pool, Secrets: s.Secrets, Conns: s.Conns}).Connect(ctx, s.scope(ctx), d)
}

func (s *Server) DescribeSource(ctx context.Context, req gen.DescribeSourceRequestObject) (gen.DescribeSourceResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	// Reuse the dataset rules by checking a spec that has only a source.
	spec := dataset.Spec{
		SpecVersion: dataset.CurrentSpecVersion,
		Fields:      []dataset.Field{{Key: "placeholder", Label: "placeholder", Column: "placeholder", Type: datasource.String, Role: dataset.Dimension}},
	}
	if err := decodeStrict(req.Body.Source, &spec.Source, "invalid_spec"); err != nil {
		return nil, err
	}
	if req.Body.Params != nil {
		if err := decodeStrict(*req.Body.Params, &spec.Params, "invalid_spec"); err != nil {
			return nil, err
		}
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}

	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	conn, err := s.connect(ctx, d)
	if err != nil {
		return nil, err
	}
	statement, err := query.SourceSQL(&spec, query.Options{Dialect: conn.Dialect(), Now: s.now(), SampleMissingParams: true})
	if err != nil {
		return nil, err
	}
	ctx, cancel, err := s.withQueryTimeout(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	columns, err := conn.Describe(ctx, statement.SQL, statement.Args)
	if err != nil {
		// The statement is the author's SQL and little else, so where the
		// database found a problem can be shown in what they wrote.
		var queryErr *datasource.QueryError
		if errors.As(err, &queryErr) && queryErr.Position > 0 {
			if offset, ok := statement.Locate(queryErr.Position - 1); ok {
				characters := utf8.RuneCountInString(spec.Source.SQL[:offset])
				return nil, &apiError{status: http.StatusUnprocessableEntity, code: "database_error", message: queryErr.Message, position: &characters}
			}
		}
		return nil, s.databaseError(ctx, d.ID, err)
	}
	out := make(gen.DescribeSource200JSONResponse, len(columns))
	for i, c := range columns {
		out[i] = gen.SourceColumn{Name: c.Name, Type: gen.LogicalType(c.Type), DbType: c.DBType}
	}
	return out, nil
}

// optional is the text, or nothing when there is none to send.
func optional(text string) *string {
	if text == "" {
		return nil
	}
	return &text
}

// explainPrefix asks any of the supported databases how it would run a statement.
const explainPrefix = "EXPLAIN "

// ExplainSource asks the database how it would run a dataset source, without
// running it. What comes back is the database's own, in its own shape.
func (s *Server) ExplainSource(ctx context.Context, req gen.ExplainSourceRequestObject) (gen.ExplainSourceResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	spec := dataset.Spec{
		SpecVersion: dataset.CurrentSpecVersion,
		Fields:      []dataset.Field{{Key: "placeholder", Label: "placeholder", Column: "placeholder", Type: datasource.String, Role: dataset.Dimension}},
	}
	if err := decodeStrict(req.Body.Source, &spec.Source, "invalid_spec"); err != nil {
		return nil, err
	}
	if req.Body.Params != nil {
		if err := decodeStrict(*req.Body.Params, &spec.Params, "invalid_spec"); err != nil {
			return nil, err
		}
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	conn, err := s.connect(ctx, d)
	if err != nil {
		return nil, err
	}
	statement, err := query.SourceSQL(&spec, query.Options{Dialect: conn.Dialect(), Now: s.now(), SampleMissingParams: true})
	if err != nil {
		return nil, err
	}
	ctx, cancel, err := s.withQueryTimeout(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	result, err := conn.Query(ctx, explainPrefix+statement.SQL, statement.Args)
	if err != nil {
		var queryErr *datasource.QueryError
		if err = datasource.Inner(err, len(explainPrefix)); errors.As(err, &queryErr) && queryErr.Position > 0 {
			if offset, ok := statement.Locate(queryErr.Position - 1); ok {
				characters := utf8.RuneCountInString(spec.Source.SQL[:offset])
				return nil, &apiError{status: http.StatusUnprocessableEntity, code: "database_error", message: queryErr.Message, position: &characters}
			}
		}
		return nil, s.databaseError(ctx, d.ID, err)
	}
	out := gen.ExplainSource200JSONResponse{Columns: make([]string, len(result.Columns)), Rows: result.Rows}
	for i, c := range result.Columns {
		out.Columns[i] = c.Name
	}
	return out, nil
}

func (s *Server) ListSourceTables(ctx context.Context, req gen.ListSourceTablesRequestObject) (gen.ListSourceTablesResponseObject, error) {
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	conn, err := s.connect(ctx, d)
	if err != nil {
		return nil, s.databaseError(ctx, d.ID, err)
	}
	ctx, cancel, err := s.withQueryTimeout(ctx)
	if err != nil {
		return nil, err
	}
	defer cancel()
	tables, err := conn.Tables(ctx)
	if err != nil {
		return nil, s.databaseError(ctx, d.ID, err)
	}
	out := gen.ListSourceTables200JSONResponse{Tables: make([]gen.SourceTable, len(tables))}
	total := 0
	for i, t := range tables {
		table := gen.SourceTable{Path: t.Path, Name: t.Name, Comment: optional(t.Comment), Columns: make([]gen.SourceTableColumn, len(t.Columns))}
		if t.Catalog != "" {
			table.Catalog = &t.Catalog
		}
		if t.Schema != "" {
			table.Schema = &t.Schema
		}
		for j, c := range t.Columns {
			table.Columns[j] = gen.SourceTableColumn{Name: c.Name, DbType: c.DBType, Comment: optional(c.Comment)}
		}
		total += len(t.Columns)
		out.Tables[i] = table
	}
	out.Truncated = total >= datasource.MaxCatalogColumns
	return out, nil
}

// dialectOf is the SQL a data source speaks, known from its kind without connecting.
func dialectOf(d store.Datasource) (dialect.Dialect, error) {
	driver, ok := datasource.Lookup(d.Type)
	if !ok {
		return nil, &apiError{status: http.StatusUnprocessableEntity, code: "unknown_datasource_type", message: "this build cannot read a data source of type " + d.Type, params: map[string]string{"type": d.Type}}
	}
	return driver.Dialect(), nil
}

// ListFunctions lists the platform's functions the data source can compute.
func (s *Server) ListFunctions(ctx context.Context, req gen.ListFunctionsRequestObject) (gen.ListFunctionsResponseObject, error) {
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	speaks, err := dialectOf(d)
	if err != nil {
		return nil, err
	}
	functions := expr.Functions(speaks)
	out := make(gen.ListFunctions200JSONResponse, len(functions))
	for i, f := range functions {
		out[i] = gen.ExpressionFunction{Name: f.Name, Category: gen.ExpressionFunctionCategory(f.Category), Aggregate: f.Aggregate, Extended: f.Extended}
	}
	return out, nil
}

// CheckExpression reads an expression as an author writes it, with fields
// referred to by name, and says what it gives or what is wrong with it.
func (s *Server) CheckExpression(ctx context.Context, req gen.CheckExpressionRequestObject) (gen.CheckExpressionResponseObject, error) {
	if req.Body == nil {
		return nil, badRequest("invalid_request", "a request body is required")
	}
	d, err := store.GetDatasource(ctx, s.Pool, s.scope(ctx), req.Id)
	if err != nil {
		return nil, err
	}
	speaks, err := dialectOf(d)
	if err != nil {
		return nil, err
	}
	// Names are compared as the dataset compares them: without regard to case.
	fold := func(label string) string { return strings.ToLower(strings.TrimSpace(label)) }
	fields := map[string]expr.FieldInfo{}
	for _, f := range req.Body.Fields {
		fields[fold(f.Label)] = expr.FieldInfo{Key: f.Label, Type: datasource.Type(f.Type), Metric: f.Metric}
	}
	text := req.Body.Expr
	failed := func(e *expr.Error) (gen.CheckExpressionResponseObject, error) {
		out := gen.ExpressionCheck{Native: false}
		out.Error = &struct {
			Code    string             `json:"code"`
			From    int                `json:"from"`
			Message string             `json:"message"`
			Params  *map[string]string `json:"params,omitempty"`
			To      int                `json:"to"`
		}{Code: e.Code, Message: e.Message, Params: &e.Params, From: utf8.RuneCountInString(text[:e.From]), To: utf8.RuneCountInString(text[:e.To])}
		return gen.CheckExpression200JSONResponse(out), nil
	}
	checked, exprErr := expr.Check(text, func(name string) (expr.FieldInfo, bool) {
		f, ok := fields[fold(name)]
		return f, ok
	}, req.Body.Metric)
	if exprErr != nil {
		return failed(exprErr)
	}
	// Writing it out is what tells whether this database has every function it uses.
	if _, exprErr := checked.SQL(expr.Env{Dialect: speaks, Zone: "UTC", Today: "2000-01-01", Ref: func(string) string { return "NULL" }}); exprErr != nil {
		return failed(exprErr)
	}
	out := gen.CheckExpression200JSONResponse{Native: checked.Native}
	if checked.Type != "" {
		t := gen.LogicalType(checked.Type)
		out.Type = &t
	}
	return out, nil
}
