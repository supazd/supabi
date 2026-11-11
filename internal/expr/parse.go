// Package expr is the platform's own language for calculated fields: a small
// set of operators and functions that mean the same on every database, and are
// written out in each database's SQL when a query is compiled. See
// .agents/design/expressions.md.
package expr

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/supazd/supabi/internal/datasource"
)

// Error is a mistake in an expression, and where it is.
type Error struct {
	// Code is stable and is what clients translate.
	Code    string
	Message string
	Params  map[string]string
	// From and To are byte offsets into the expression.
	From, To int
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func errorAt(from, to int, code string, pairs []string, format string, args ...any) *Error {
	params := map[string]string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		params[pairs[i]] = pairs[i+1]
	}
	return &Error{Code: code, Message: fmt.Sprintf(format, args...), Params: params, From: from, To: to}
}

// Node is a part of an expression.
type Node interface {
	// Span is where the part is written.
	Span() (from, to int)
}

type span struct{ from, to int }

func (s span) Span() (int, int) { return s.from, s.to }

type (
	// Lit is a value written out. Type is empty for NULL.
	Lit struct {
		span
		Type datasource.Type
		// Text is the number as written, the text without its quotes, or
		// "true" or "false".
		Text string
	}
	// Ref refers to another field as ${name}.
	Ref struct {
		span
		Name string
	}
	Unary struct {
		span
		Op string // "-" or "not"
		X  Node
	}
	Binary struct {
		span
		Op   string // + - * / % = <> < <= > >= and or
		L, R Node
	}
	Call struct {
		span
		// Name is in upper case, however it was written.
		Name string
		Args []Node
		// name is where the name is written.
		name span
	}
	Case struct {
		span
		// Subject is what each WHEN is compared with, or nil when each WHEN is a condition.
		Subject Node
		Whens   []When
		Else    Node
	}
	When struct{ Cond, Then Node }
	In   struct {
		span
		X    Node
		List []Node
		Not  bool
	}
	Between struct {
		span
		X, Low, High Node
		Not          bool
	}
	IsNull struct {
		span
		X   Node
		Not bool
	}
)

type tokenKind int

const (
	tokEnd tokenKind = iota
	tokNumber
	tokString
	tokRef
	tokWord
	tokSymbol
)

type token struct {
	kind tokenKind
	// text is the symbol, the word in upper case, the number, the text of a
	// string without its quotes, or the name inside a reference.
	text string
	span
}

func lex(text string) ([]token, *Error) {
	var tokens []token
	for i := 0; i < len(text); {
		c := text[i]
		start := i
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case c >= '0' && c <= '9' || c == '.' && i+1 < len(text) && text[i+1] >= '0' && text[i+1] <= '9':
			for i < len(text) && text[i] >= '0' && text[i] <= '9' {
				i++
			}
			if i < len(text) && text[i] == '.' {
				i++
				for i < len(text) && text[i] >= '0' && text[i] <= '9' {
					i++
				}
			}
			tokens = append(tokens, token{tokNumber, text[start:i], span{start, i}})
		case c == '\'':
			var value strings.Builder
			i++
			for closed := false; !closed; {
				switch {
				case i >= len(text):
					return nil, errorAt(start, len(text), "expr_unclosed_string", nil, "the text that starts here is never closed")
				case text[i] != '\'':
					value.WriteByte(text[i])
					i++
				case i+1 < len(text) && text[i+1] == '\'':
					value.WriteByte('\'')
					i += 2
				default:
					i++
					closed = true
				}
			}
			tokens = append(tokens, token{tokString, value.String(), span{start, i}})
		case c == '"' || c == '`':
			return nil, errorAt(start, start+1, "expr_quote", nil, "text is written in single quotes, and a field as ${name}")
		case c == '$' && i+1 < len(text) && text[i+1] == '{':
			end := strings.IndexByte(text[i:], '}')
			if end < 0 {
				return nil, errorAt(start, len(text), "expr_unclosed_reference", nil, "a ${ is never closed")
			}
			i += end + 1
			tokens = append(tokens, token{tokRef, strings.TrimSpace(text[start+2 : i-1]), span{start, i}})
		case strings.ContainsRune("+-*/%(),=", rune(c)):
			i++
			tokens = append(tokens, token{tokSymbol, string(c), span{start, i}})
		case c == '<' || c == '>' || c == '!':
			i++
			if i < len(text) && (text[i] == '=' || c == '<' && text[i] == '>') {
				i++
			}
			symbol := text[start:i]
			if symbol == "!" {
				return nil, errorAt(start, i, "expr_unexpected", []string{"found", "!"}, "unexpected %q", "!")
			}
			if symbol == "!=" {
				symbol = "<>"
			}
			tokens = append(tokens, token{tokSymbol, symbol, span{start, i}})
		default:
			r, size := utf8.DecodeRuneInString(text[i:])
			if !unicode.IsLetter(r) && r != '_' {
				return nil, errorAt(start, start+size, "expr_unexpected", []string{"found", string(r)}, "unexpected %q", string(r))
			}
			for i < len(text) {
				r, size = utf8.DecodeRuneInString(text[i:])
				if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' {
					break
				}
				i += size
			}
			tokens = append(tokens, token{tokWord, strings.ToUpper(text[start:i]), span{start, i}})
		}
	}
	return append(tokens, token{tokEnd, "", span{len(text), len(text)}}), nil
}

// Words that are part of the language, and so cannot be the name of a function.
var keywords = map[string]bool{
	"AND": true, "OR": true, "NOT": true, "CASE": true, "WHEN": true, "THEN": true, "ELSE": true, "END": true,
	"IN": true, "BETWEEN": true, "IS": true, "NULL": true, "TRUE": true, "FALSE": true, "DISTINCT": true,
}

type parser struct {
	tokens []token
	at     int
	depth  int
}

// maxDepth is how deeply brackets, NOT and minus signs may nest. The parser
// calls itself for each, and a stack that runs out ends the whole process:
// that cannot be recovered from. No expression written by a person is close.
const maxDepth = 200

// maxLength is how long an expression may be, in bytes.
const maxLength = 20000

// enter counts one more level of nesting, begun at t. Each call that
// succeeds is matched by a p.depth-- when the level has been read.
func (p *parser) enter(t token) *Error {
	if p.depth >= maxDepth {
		return errorAt(t.from, t.to, "expr_too_deep", nil, "the expression is nested too deeply")
	}
	p.depth++
	return nil
}

// Parse reads an expression.
func Parse(text string) (Node, *Error) {
	// A chain of operators nests as deeply as it is long once it is a tree,
	// which checking and writing it out then walk by calling themselves.
	if len(text) > maxLength {
		return nil, errorAt(0, len(text), "expr_too_long", []string{"max", strconv.Itoa(maxLength)}, "the expression is longer than %d bytes", maxLength)
	}
	tokens, err := lex(text)
	if err != nil {
		return nil, err
	}
	p := &parser{tokens: tokens}
	if p.peek().kind == tokEnd {
		return nil, errorAt(0, len(text), "expr_empty", nil, "the expression is empty")
	}
	node, err := p.or()
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != tokEnd {
		return nil, p.unexpected(t)
	}
	return node, nil
}

func (p *parser) peek() token { return p.tokens[p.at] }

func (p *parser) next() token {
	t := p.tokens[p.at]
	if t.kind != tokEnd {
		p.at++
	}
	return t
}

func (p *parser) is(kind tokenKind, text string) bool {
	t := p.peek()
	return t.kind == kind && t.text == text
}

func (p *parser) accept(kind tokenKind, text string) bool {
	if p.is(kind, text) {
		p.at++
		return true
	}
	return false
}

func (p *parser) unexpected(t token) *Error {
	if t.kind == tokEnd {
		return errorAt(t.from, t.to, "expr_incomplete", nil, "the expression ends too soon")
	}
	found := t.text
	if t.kind == tokString || t.kind == tokRef {
		found = "…"
	}
	return errorAt(t.from, t.to, "expr_unexpected", []string{"found", found}, "unexpected %q", found)
}

func (p *parser) expect(kind tokenKind, text string) (token, *Error) {
	if !p.is(kind, text) {
		t := p.peek()
		if t.kind == tokEnd {
			return t, errorAt(t.from, t.to, "expr_expected", []string{"expected", text}, "%s is missing at the end", text)
		}
		return t, errorAt(t.from, t.to, "expr_expected", []string{"expected", text}, "%s is expected here", text)
	}
	return p.next(), nil
}

func between(a, b Node) span {
	from, _ := a.Span()
	_, to := b.Span()
	return span{from, to}
}

// or is where every nested expression starts: one in brackets, an argument
// of a function, a part of CASE or IN.
func (p *parser) or() (Node, *Error) {
	if err := p.enter(p.peek()); err != nil {
		return nil, err
	}
	defer func() { p.depth-- }()
	left, err := p.and()
	for err == nil && p.accept(tokWord, "OR") {
		var right Node
		if right, err = p.and(); err == nil {
			left = &Binary{between(left, right), "or", left, right}
		}
	}
	return left, err
}

func (p *parser) and() (Node, *Error) {
	left, err := p.not()
	for err == nil && p.accept(tokWord, "AND") {
		var right Node
		if right, err = p.not(); err == nil {
			left = &Binary{between(left, right), "and", left, right}
		}
	}
	return left, err
}

func (p *parser) not() (Node, *Error) {
	if t := p.peek(); p.accept(tokWord, "NOT") {
		if err := p.enter(t); err != nil {
			return nil, err
		}
		x, err := p.not()
		p.depth--
		if err != nil {
			return nil, err
		}
		_, to := x.Span()
		return &Unary{span{t.from, to}, "not", x}, nil
	}
	return p.comparison()
}

var comparisons = map[string]bool{"=": true, "<>": true, "<": true, "<=": true, ">": true, ">=": true}

func (p *parser) comparison() (Node, *Error) {
	left, err := p.sum()
	if err != nil {
		return nil, err
	}
	t := p.peek()
	switch {
	case t.kind == tokSymbol && comparisons[t.text]:
		p.next()
		right, err := p.sum()
		if err != nil {
			return nil, err
		}
		return &Binary{between(left, right), t.text, left, right}, nil
	case p.accept(tokWord, "IS"):
		not := p.accept(tokWord, "NOT")
		end, err := p.expect(tokWord, "NULL")
		if err != nil {
			return nil, err
		}
		from, _ := left.Span()
		return &IsNull{span{from, end.to}, left, not}, nil
	}

	not := false
	if t.kind == tokWord && t.text == "NOT" {
		// NOT here can only go with IN or BETWEEN.
		p.next()
		not = true
	}
	from, _ := left.Span()
	switch {
	case p.accept(tokWord, "IN"):
		if _, err := p.expect(tokSymbol, "("); err != nil {
			return nil, err
		}
		var list []Node
		for {
			item, err := p.or()
			if err != nil {
				return nil, err
			}
			list = append(list, item)
			if !p.accept(tokSymbol, ",") {
				break
			}
		}
		end, err := p.expect(tokSymbol, ")")
		if err != nil {
			return nil, err
		}
		return &In{span{from, end.to}, left, list, not}, nil
	case p.accept(tokWord, "BETWEEN"):
		low, err := p.sum()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokWord, "AND"); err != nil {
			return nil, err
		}
		high, err := p.sum()
		if err != nil {
			return nil, err
		}
		_, to := high.Span()
		return &Between{span{from, to}, left, low, high, not}, nil
	}
	if not {
		return nil, p.unexpected(p.peek())
	}
	return left, nil
}

func (p *parser) sum() (Node, *Error) {
	left, err := p.product()
	for err == nil && (p.is(tokSymbol, "+") || p.is(tokSymbol, "-")) {
		op := p.next().text
		var right Node
		if right, err = p.product(); err == nil {
			left = &Binary{between(left, right), op, left, right}
		}
	}
	return left, err
}

func (p *parser) product() (Node, *Error) {
	left, err := p.unary()
	for err == nil && (p.is(tokSymbol, "*") || p.is(tokSymbol, "/") || p.is(tokSymbol, "%")) {
		op := p.next().text
		var right Node
		if right, err = p.unary(); err == nil {
			left = &Binary{between(left, right), op, left, right}
		}
	}
	return left, err
}

func (p *parser) unary() (Node, *Error) {
	if t := p.peek(); p.accept(tokSymbol, "-") {
		if err := p.enter(t); err != nil {
			return nil, err
		}
		x, err := p.unary()
		p.depth--
		if err != nil {
			return nil, err
		}
		_, to := x.Span()
		return &Unary{span{t.from, to}, "-", x}, nil
	}
	return p.primary()
}

func (p *parser) primary() (Node, *Error) {
	t := p.next()
	switch t.kind {
	case tokNumber:
		kind := datasource.Integer
		if strings.Contains(t.text, ".") {
			kind = datasource.Decimal
		}
		return &Lit{t.span, kind, t.text}, nil
	case tokString:
		return &Lit{t.span, datasource.String, t.text}, nil
	case tokRef:
		if t.text == "" {
			return nil, errorAt(t.from, t.to, "expr_empty_reference", nil, "a reference needs the name of a field")
		}
		return &Ref{t.span, t.text}, nil
	case tokSymbol:
		if t.text == "(" {
			inner, err := p.or()
			if err != nil {
				return nil, err
			}
			if _, err := p.expect(tokSymbol, ")"); err != nil {
				return nil, err
			}
			return inner, nil
		}
	case tokWord:
		switch t.text {
		case "TRUE", "FALSE":
			return &Lit{t.span, datasource.Boolean, strings.ToLower(t.text)}, nil
		case "NULL":
			return &Lit{t.span, "", ""}, nil
		case "CASE":
			return p.caseWhen(t)
		}
		if keywords[t.text] {
			break
		}
		if !p.is(tokSymbol, "(") {
			return nil, errorAt(t.from, t.to, "expr_bare_word", []string{"word", t.text}, "%s is not something an expression knows: a field is written ${name}, and text in single quotes", t.text)
		}
		return p.call(t)
	}
	return nil, p.unexpected(t)
}

func (p *parser) call(name token) (Node, *Error) {
	p.next() // the opening parenthesis
	call := &Call{Name: name.text, name: name.span}
	switch {
	case p.accept(tokSymbol, ")"):
	case name.text == "COUNT" && p.is(tokSymbol, "*"):
		// COUNT(*) counts rows, the same as COUNT().
		p.next()
		if _, err := p.expect(tokSymbol, ")"); err != nil {
			return nil, err
		}
	default:
		if name.text == "COUNT" && p.accept(tokWord, "DISTINCT") {
			call.Name = "COUNT_DISTINCT"
		}
		for {
			arg, err := p.or()
			if err != nil {
				return nil, err
			}
			call.Args = append(call.Args, arg)
			if !p.accept(tokSymbol, ",") {
				break
			}
		}
		if _, err := p.expect(tokSymbol, ")"); err != nil {
			return nil, err
		}
	}
	call.span = span{name.from, p.tokens[p.at-1].to}
	return call, nil
}

func (p *parser) caseWhen(start token) (Node, *Error) {
	node := &Case{}
	if !p.is(tokWord, "WHEN") {
		subject, err := p.or()
		if err != nil {
			return nil, err
		}
		node.Subject = subject
	}
	for p.accept(tokWord, "WHEN") {
		cond, err := p.or()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(tokWord, "THEN"); err != nil {
			return nil, err
		}
		then, err := p.or()
		if err != nil {
			return nil, err
		}
		node.Whens = append(node.Whens, When{cond, then})
	}
	if len(node.Whens) == 0 {
		if _, err := p.expect(tokWord, "WHEN"); err != nil {
			return nil, err
		}
	}
	if p.accept(tokWord, "ELSE") {
		otherwise, err := p.or()
		if err != nil {
			return nil, err
		}
		node.Else = otherwise
	}
	end, err := p.expect(tokWord, "END")
	if err != nil {
		return nil, err
	}
	node.span = span{start.from, end.to}
	return node, nil
}
