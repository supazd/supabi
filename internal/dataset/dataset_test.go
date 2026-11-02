package dataset

import (
	"errors"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

func validSpec() *Spec {
	return &Spec{
		SpecVersion: 1,
		Source:      Source{Type: "sql", SQL: "SELECT * FROM orders WHERE dt >= {{start}} [[ AND region IN {{regions}} ]]"},
		Params: []Param{
			{Name: "start", Type: datasource.Date, Required: true},
			{Name: "regions", Type: datasource.String, Multi: true},
		},
		Fields: []Field{
			{Key: "amount", Label: "Amount", Column: "amount", Type: datasource.Decimal, Role: MeasureRole},
			{Key: "user_id", Label: "User", Column: "user_id", Type: datasource.String, Role: Dimension},
			{Key: "created", Label: "Created", Column: "created_at", Type: datasource.Timestamp, Role: Dimension},
			{Key: "tier", Label: "Tier", Expr: "CASE WHEN ${amount} >= 100 THEN 'high' ELSE 'low' END", Type: datasource.String, Role: Dimension},
			{Key: "buyers", Label: "Buyers", Column: "user_id", Type: datasource.String, Role: Dimension},
			{Key: "arpu", Label: "ARPU", Expr: "SUM(${amount}) / NULLIF(COUNT(DISTINCT ${user_id}), 0)", Type: datasource.Decimal, Role: Metric},
			{Key: "arpu_pct", Label: "ARPU %", Expr: "${arpu} * 100", Type: datasource.Decimal, Role: Metric},
		},
	}
}

func code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	if err != nil {
		return "non-dataset error: " + err.Error()
	}
	return ""
}

func TestValidate(t *testing.T) {
	if err := validSpec().Validate(); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Spec)
		want   string
	}{
		{"future version", func(s *Spec) { s.SpecVersion = 2 }, "unsupported_spec_version"},
		{"not a select", func(s *Spec) { s.Source.SQL = "DELETE FROM orders" }, "source_not_select"},
		{"two statements", func(s *Spec) { s.Source.SQL = "SELECT 1; DROP TABLE orders" }, "source_multiple_statements"},
		{"with is allowed", func(s *Spec) { s.Source.SQL = "  WITH x AS (SELECT 1) SELECT * FROM x;" }, ""},
		{"undeclared param", func(s *Spec) { s.Source.SQL += " AND x = {{other}}" }, "undeclared_param"},
		{"unclosed placeholder", func(s *Spec) { s.Source.SQL += " AND x = {{start" }, "template_unbalanced"},
		{"unclosed block", func(s *Spec) { s.Source.SQL += " [[ AND 1 = 1" }, "template_unbalanced"},
		{"duplicate key", func(s *Spec) { s.Fields[4].Key = "amount" }, "duplicate_key"},
		{"bad key", func(s *Spec) { s.Fields[0].Key = "Amount" }, "invalid_key"},
		{"bad type", func(s *Spec) { s.Fields[0].Type = "money" }, "invalid_type"},
		{"empty name", func(s *Spec) { s.Fields[1].Label = "" }, "invalid_label"},
		{"name with braces", func(s *Spec) { s.Fields[1].Label = "a}b" }, "invalid_label"},
		{"name with outer spaces", func(s *Spec) { s.Fields[1].Label = " User" }, "invalid_label"},
		{"name too long", func(s *Spec) { s.Fields[1].Label = strings.Repeat("名", 101) }, "invalid_label"},
		{"long name in another script", func(s *Spec) { s.Fields[1].Label = strings.Repeat("名", 100) }, ""},
		{"same name twice", func(s *Spec) { s.Fields[1].Label = "Tier" }, "duplicate_label"},
		{"names differing only in case", func(s *Spec) { s.Fields[1].Label = "tIER" }, "duplicate_label"},
		{"no role", func(s *Spec) { s.Fields[1].Role = "" }, "invalid_role"},
		// A measure is a number on each row; text is a dimension, counted in a chart.
		{"measure of text", func(s *Spec) { s.Fields[4].Role = MeasureRole }, "measure_not_numeric"},
		{"measure of dates", func(s *Spec) { s.Fields[2].Role = MeasureRole }, "measure_not_numeric"},
		{"numeric dimension", func(s *Spec) { s.Fields[0].Role = Dimension }, ""},
		{"metric that is a plain column", func(s *Spec) { s.Fields[0].Role = Metric }, "metric_column"},
		{"reference to nothing", func(s *Spec) { s.Fields[5].Expr = "SUM(${nope})" }, "unknown_reference"},
		{"row-level field refers to a metric", func(s *Spec) { s.Fields[3].Expr = "${arpu}" }, "metric_reference"},
		{"metric cycle", func(s *Spec) { s.Fields[5].Expr = "${arpu_pct} / 100" }, "circular_reference"},
		{"field cycle", func(s *Spec) { s.Fields[0].Column, s.Fields[0].Expr = "", "${tier}" }, "circular_reference"},
		{"neither a column nor an expression", func(s *Spec) { s.Fields[0].Column = "" }, "empty_expr"},
		{"an expression of nothing but spaces", func(s *Spec) { s.Fields[3].Expr = "  " }, "empty_expr"},
		{"both a column and an expression", func(s *Spec) { s.Fields[0].Expr = "amount * 2" }, "column_and_expr"},
		{"a column name that cannot be written", func(s *Spec) { s.Fields[0].Column = "a\x00b" }, "invalid_column"},
		// An expression in the platform's language is read here, without a database.
		{"standard expression", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "IF(${amount} >= 100, 'high', 'low')" }, ""},
		{"standard metric over a native one", func(s *Spec) { s.Fields[6].Syntax = Standard }, ""},
		{"standard expression with a mistake", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "IF(${amount} >= 100, 'high')" }, "expr_arguments"},
		{"standard expression of another type", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "${amount} * 2" }, "field_type_mismatch"},
		{"standard expression that aggregates in a row", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "TO_STRING(COUNT())" }, "expr_aggregate_in_row"},
		{"standard metric that does not aggregate", func(s *Spec) { s.Fields[5].Syntax, s.Fields[5].Expr = Standard, "${amount} * 2" }, "expr_metric_needs_aggregate"},
		{"standard reference to nothing", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "UPPER(${nope})" }, "unknown_reference"},
		{"standard row-level field refers to a metric", func(s *Spec) { s.Fields[3].Syntax, s.Fields[3].Expr = Standard, "TO_STRING(${arpu})" }, "metric_reference"},
		{"standard cycle", func(s *Spec) { s.Fields[5].Syntax, s.Fields[5].Expr = Standard, "${arpu_pct} / 100" }, "circular_reference"},
		{"unknown syntax", func(s *Spec) { s.Fields[3].Syntax = "excel" }, "invalid_syntax"},
		{"syntax on a column", func(s *Spec) { s.Fields[0].Syntax = Standard }, "invalid_syntax"},
		// Display formats.
		{"full format", func(s *Spec) {
			s.Fields[0].Format = &Format{Style: "number", Decimals: new(2), Grouping: new(false), Unit: "wan", Prefix: "¥", Suffix: "元"}
		}, ""},
		{"percent", func(s *Spec) { s.Fields[0].Format = &Format{Style: "percent", Decimals: new(1)} }, ""},
		{"empty format", func(s *Spec) { s.Fields[0].Format = &Format{} }, ""},
		{"format on text", func(s *Spec) { s.Fields[4].Format = &Format{} }, "format_not_supported"},
		{"date properties on a number", func(s *Spec) { s.Fields[0].Format = &Format{Date: "dash"} }, "invalid_format"},
		{"week on a number", func(s *Spec) { s.Fields[0].Format = &Format{Week: "number"} }, "invalid_format"},
		{"full date format", func(s *Spec) { s.Fields[2].Format = &Format{Date: "slash", Time: "minute", Week: "number"} }, ""},
		{"empty date format", func(s *Spec) { s.Fields[2].Format = &Format{} }, ""},
		{"date only", func(s *Spec) { s.Fields[2].Format = &Format{Time: "none"} }, ""},
		{"unknown date style", func(s *Spec) { s.Fields[2].Format = &Format{Date: "iso"} }, "invalid_format"},
		{"unknown time", func(s *Spec) { s.Fields[2].Format = &Format{Time: "hour"} }, "invalid_format"},
		{"unknown week", func(s *Spec) { s.Fields[2].Format = &Format{Week: "end"} }, "invalid_format"},
		{"none on a date", func(s *Spec) { s.Fields[2].Format = &Format{Style: "none"} }, "invalid_format"},
		{"number properties on a date", func(s *Spec) { s.Fields[2].Format = &Format{Decimals: new(2)} }, "invalid_format"},
		{"time on a date", func(s *Spec) {
			s.Fields[2].Type, s.Fields[2].Format = datasource.Date, &Format{Time: "minute"}
		}, "invalid_format"},
		{"week on a date", func(s *Spec) {
			s.Fields[2].Type, s.Fields[2].Format = datasource.Date, &Format{Date: "chinese", Week: "start"}
		}, ""},
		{"unknown style", func(s *Spec) { s.Fields[0].Format = &Format{Style: "currency"} }, "invalid_format"},
		{"none", func(s *Spec) { s.Fields[0].Format = &Format{Style: "none"} }, ""},
		{"none with a unit", func(s *Spec) { s.Fields[0].Format = &Format{Style: "none", Unit: "wan"} }, "invalid_format"},
		{"none with grouping", func(s *Spec) { s.Fields[0].Format = &Format{Style: "none", Grouping: new(false)} }, "invalid_format"},
		{"negative decimals", func(s *Spec) { s.Fields[0].Format = &Format{Decimals: new(-1)} }, "invalid_format"},
		{"too many decimals", func(s *Spec) { s.Fields[0].Format = &Format{Decimals: new(11)} }, "invalid_format"},
		{"unknown unit", func(s *Spec) { s.Fields[0].Format = &Format{Unit: "k"} }, "invalid_format"},
		{"percent with a unit", func(s *Spec) { s.Fields[0].Format = &Format{Style: "percent", Unit: "K"} }, "invalid_format"},
		{"long prefix", func(s *Spec) { s.Fields[0].Format = &Format{Prefix: strings.Repeat("元", 17)} }, "invalid_format"},
		{"suffix with a line break", func(s *Spec) { s.Fields[0].Format = &Format{Suffix: "a\nb"} }, "invalid_format"},
	}
	for _, tt := range tests {
		s := validSpec()
		tt.mutate(s)
		if got := code(s.Validate()); got != tt.want {
			t.Errorf("%s: got %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestFieldSQL(t *testing.T) {
	s := validSpec()
	quote := Writer{Quote: func(name string) string { return `t."` + name + `"` }}
	tests := map[string]string{
		"tier": `CASE WHEN (t."amount") >= 100 THEN 'high' ELSE 'low' END`,
		// A reference to a measure is its row-level value, not its default aggregation.
		"arpu": `SUM((t."amount")) / NULLIF(COUNT(DISTINCT (t."user_id")), 0)`,
		// A reference to an aggregated field is its whole expression.
		"arpu_pct": `(SUM((t."amount")) / NULLIF(COUNT(DISTINCT (t."user_id")), 0)) * 100`,
	}
	for key, want := range tests {
		if got, _ := s.FieldSQL(key, quote); got != want {
			t.Errorf("FieldSQL(%s) = %s, want %s", key, got, want)
		}
	}

	// A column is a name and nothing else: it is handed to the database's own
	// quoting whatever is in it. An expression is left as it was written, even
	// one that is only a name.
	for column, want := range map[string]string{
		"订单id":          `t."订单id"`,
		"订单 id":         `t."订单 id"`,
		"amount(元)":     `t."amount(元)"`,
		"1st":           `t."1st"`,
		"a; DROP TABLE": `t."a; DROP TABLE"`,
	} {
		s.Fields[0].Column = column
		if got, _ := s.FieldSQL(s.Fields[0].Key, quote); got != want {
			t.Errorf("FieldSQL of column %q = %s, want %s", column, got, want)
		}
	}
	s.Fields[0].Column, s.Fields[0].Expr = "", "amount"
	if got, _ := s.FieldSQL(s.Fields[0].Key, quote); got != "amount" {
		t.Errorf("FieldSQL of an expression that is a name = %s", got)
	}
}

func render(t *testing.T, sql string, values map[string]bool) (string, string) {
	t.Helper()
	tpl, err := ParseTemplate(sql)
	if err != nil {
		t.Fatal(err)
	}
	var sb strings.Builder
	missing := tpl.Render(func(n string) bool { return values[n] }, func(s string, _ int) { sb.WriteString(s) }, func(n string) { sb.WriteString("<" + n + ">") })
	return sb.String(), missing
}

// Every piece of literal text is reported with where it came from.
func TestTemplatePositions(t *testing.T) {
	const sql = "SELECT a[1], '中文 {x}' FROM t WHERE d = {{ day }} [[ AND r IN {{regions}} AND s[2] = {{status}} ]] ORDER BY 1"
	tpl, err := ParseTemplate(sql)
	if err != nil {
		t.Fatal(err)
	}
	pieces := 0
	tpl.Render(func(string) bool { return true }, func(s string, pos int) {
		pieces++
		if pos+len(s) > len(sql) || sql[pos:pos+len(s)] != s {
			t.Errorf("text %q is reported at %d, where the SQL has %q", s, pos, sql[min(pos, len(sql)):])
		}
	}, func(string) {})
	if pieces < 5 {
		t.Errorf("only %d pieces of text", pieces)
	}
}

func TestTemplate(t *testing.T) {
	const sql = "SELECT a[1], '{x}' FROM t WHERE d = {{ day }} [[ AND r IN {{regions}} AND s = {{status}} ]] ORDER BY 1"
	tpl, err := ParseTemplate(sql)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(tpl.ParamNames(), ","); got != "day,regions,status" {
		t.Errorf("ParamNames = %s", got)
	}
	if got, missing := render(t, sql, map[string]bool{"day": true, "regions": true, "status": true}); missing != "" ||
		got != "SELECT a[1], '{x}' FROM t WHERE d = <day>  AND r IN <regions> AND s = <status>  ORDER BY 1" {
		t.Errorf("all set: %q (missing %q)", got, missing)
	}
	// A block is all or nothing: one missing value drops it entirely.
	if got, missing := render(t, sql, map[string]bool{"day": true, "regions": true}); missing != "" ||
		got != "SELECT a[1], '{x}' FROM t WHERE d = <day>  ORDER BY 1" {
		t.Errorf("block dropped: %q (missing %q)", got, missing)
	}
	if _, missing := render(t, sql, map[string]bool{}); missing != "day" {
		t.Errorf("missing = %q, want day", missing)
	}
	for _, bad := range []string{"SELECT {{1x}}", "SELECT [[ a [[ b ]] ]]", "SELECT 1 ]]"} {
		if _, err := ParseTemplate(bad); err == nil {
			t.Errorf("ParseTemplate(%q) should fail", bad)
		}
	}
}

// Only SQL itself is read for parameters. In a string, a quoted name or a
// comment, braces and brackets are text, as they are to the database.
func TestTemplateLeavesTextAlone(t *testing.T) {
	for sql, want := range map[string]string{
		// A string that says {{status}}, not a parameter in quotes.
		"WHERE status = '{{status}}'":                                "WHERE status = '{{status}}'",
		"WHERE name LIKE '%{{word}}%' AND status = {{status}}":       "WHERE name LIKE '%{{word}}%' AND status = <status>",
		"WHERE a = 'it''s {{word}}' AND status = {{status}}":         "WHERE a = 'it''s {{word}}' AND status = <status>",
		"SELECT \"{{a}}\", `{{b}}` FROM t WHERE status = {{status}}": "SELECT \"{{a}}\", `{{b}}` FROM t WHERE status = <status>",
		// What is commented out asks for nothing.
		"WHERE status = {{status}} -- AND day = {{day}}":              "WHERE status = <status> -- AND day = {{day}}",
		"WHERE status = {{status}}\n-- AND day = {{day}}\nORDER BY 1": "WHERE status = <status>\n-- AND day = {{day}}\nORDER BY 1",
		"WHERE status = {{status}} /* [[ AND day = {{day}} ]] */":     "WHERE status = <status> /* [[ AND day = {{day}} ]] */",
		// Nor do brackets in a string open or close anything.
		"WHERE tag = '[[x]]' [[ AND status = {{status}} ]]":        "WHERE tag = '[[x]]'  AND status = <status> ",
		"WHERE 1 = 1 [[ AND tag = ']]' AND status = {{status}} ]]": "WHERE 1 = 1  AND tag = ']]' AND status = <status> ",
		// Quotes and comment marks inside one another start nothing.
		"WHERE a = '--' AND status = {{status}}":          "WHERE a = '--' AND status = <status>",
		"WHERE a = '/*' AND status = {{status}} -- don't": "WHERE a = '/*' AND status = <status> -- don't",
		"WHERE a = '' AND status = {{status}}":            "WHERE a = '' AND status = <status>",
		// Never closed: text to the end.
		"WHERE status = {{status}} AND a = '{{word}}": "WHERE status = <status> AND a = '{{word}}",
	} {
		tpl, err := ParseTemplate(sql)
		if err != nil {
			t.Errorf("%s: %v", sql, err)
			continue
		}
		if names := strings.Join(tpl.ParamNames(), ","); names != "status" && !(names == "" && !strings.Contains(want, "<status>")) {
			t.Errorf("%s: parameters = %q", sql, names)
		}
		if got, missing := render(t, sql, map[string]bool{"status": true}); got != want || missing != "" {
			t.Errorf("%s\n  got %q (missing %q)\n want %q", sql, got, missing, want)
		}
	}

	// Text is still reported where it is, in pieces or not.
	const sql = "SELECT '{{a}}' WHERE status = {{status}} -- {{b}}\n ORDER BY 1"
	tpl, _ := ParseTemplate(sql)
	var whole strings.Builder
	tpl.Render(func(string) bool { return true }, func(s string, pos int) {
		whole.WriteString(s)
		if sql[pos:pos+len(s)] != s {
			t.Errorf("text %q is reported at %d, where the SQL has %q", s, pos, sql[pos:])
		}
	}, func(string) { whole.WriteString("{{status}}") })
	if whole.String() != sql {
		t.Errorf("pieces add up to %q", whole.String())
	}
}
