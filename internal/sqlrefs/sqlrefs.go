// Package sqlrefs finds the tables a statement reads, in SQL someone wrote.
//
// It does not parse SQL. It tells the words of a statement from its strings
// and comments, and takes what is named where a table is named: after FROM
// and JOIN. That is the same in every database supported, so one reading
// serves them all, and a statement it cannot follow gives fewer tables
// rather than an error. What it misses is a table reached some other way,
// through a function such as read_parquet or remote.
//
// The same reading finds where a statement marks its bound arguments, for a
// driver that writes their values in itself.
package sqlrefs

import (
	"strings"

	"github.com/supazd/supabi/internal/dialect"
)

// Table is a table as a statement names it.
type Table struct {
	// Path is the name part by part, outermost first and without quotes: the
	// table alone, or the schema and whatever else the statement wrote before it.
	Path []string
}

// Name is the table's own name, without what it is in.
func (t Table) Name() string { return t.Path[len(t.Path)-1] }

// String is the name as it would be written, the parts joined by dots.
func (t Table) String() string { return strings.Join(t.Path, ".") }

// Placeholders returns where the statement marks its bound arguments with ?,
// in bytes and in order. A ? in a string, a quoted name or a comment is not one.
func Placeholders(sql string, lexis dialect.Lexis) []int {
	var at []int
	for _, t := range lex(sql, lexis) {
		if t.kind == punct && t.text == "?" {
			at = append(at, t.at)
		}
	}
	return at
}

// Tables lists the tables the SQL reads, each once, in the order they are
// first named. The SQL may be a template: its {{parameters}} stand for values
// and its [[ ]] blocks are read as if they were kept.
//
// A name the statement defines itself in a WITH clause is not a table, and
// neither is a function called where a table would be.
func Tables(sql string, lexis dialect.Lexis) []Table {
	toks := lex(sql, lexis)
	defined := commonTables(toks)
	var out []Table
	seen := map[string]bool{}

	// A frame is what is between a pair of brackets, or the statement itself.
	type frame struct {
		selecting bool // a SELECT was met, and its FROM is still to come
		from      bool // in the FROM clause, where JOIN names a table
		list      bool // and where a comma does too
		empty     bool
	}
	frames := []frame{{empty: true}}
	// Set where the next thing is a table, a subquery or a function.
	expect := false

	for i := 0; i < len(toks); i++ {
		t := toks[i]
		top := &frames[len(frames)-1]
		wasEmpty := top.empty
		top.empty = false

		if expect {
			switch {
			case t.is("LATERAL"), t.is("ONLY"):
				continue
			case t.kind == punct && t.text == "(":
				// A subquery, or joins in brackets: tables are still named in there.
				frames = append(frames, frame{from: true, list: true, empty: true})
				continue
			case t.name() && !t.isAny("SELECT", "WITH", "VALUES", "TABLE", "WHERE"):
				path := []string{t.text}
				for i+2 < len(toks) && toks[i+1].kind == punct && toks[i+1].text == "." && toks[i+2].name() {
					path = append(path, toks[i+2].text)
					i += 2
				}
				expect = false
				called := i+1 < len(toks) && toks[i+1].kind == punct && toks[i+1].text == "("
				own := len(path) == 1 && (defined[strings.ToLower(path[0])] || (t.kind == word && strings.EqualFold(path[0], "DUAL")))
				if key := strings.Join(path, "\x00"); !called && !own && !seen[key] {
					seen[key] = true
					out = append(out, Table{Path: path})
				}
				continue
			}
			expect = false
		}

		switch {
		case t.kind == punct && t.text == "(":
			frames = append(frames, frame{empty: true})
		case t.kind == punct && t.text == ")":
			if len(frames) > 1 {
				frames = frames[:len(frames)-1]
			}
		case t.kind == punct && t.text == ";":
			frames = []frame{{empty: true}}
		case t.kind == punct && t.text == ",":
			expect = top.from && top.list
		case t.is("SELECT"):
			*top = frame{selecting: true}
		case t.is("FROM"):
			// The FROM of a SELECT, and not the one inside EXTRACT(x FROM y),
			// which has no SELECT in its brackets, nor that of IS DISTINCT FROM.
			// Some databases let a statement begin with it.
			if (top.selecting && !(i > 0 && toks[i-1].is("DISTINCT") && i > 1 && toks[i-2].isAny("IS", "NOT"))) || (wasEmpty && len(frames) == 1) {
				top.selecting, top.from, top.list = false, true, true
				expect = true
			}
		case t.is("JOIN"), t.is("STRAIGHT_JOIN"):
			if !top.from {
				break
			}
			// ClickHouse's ARRAY JOIN unfolds a column: what follows it, and
			// what follows the commas after it, are expressions.
			if i > 0 && toks[i-1].is("ARRAY") {
				top.list = false
				break
			}
			expect = true
		case t.isAny("WHERE", "PREWHERE", "GROUP", "HAVING", "QUALIFY", "WINDOW", "ORDER", "LIMIT", "OFFSET", "FETCH", "UNION", "INTERSECT", "EXCEPT", "SETTINGS", "RETURNING"):
			top.from = false
		}
	}
	return out
}

// commonTables finds the names a statement gives to its own subqueries:
//
//	WITH paid AS (SELECT ...), by_day (dt, total) AS (SELECT ...)
//
// Nothing else is written as a name, AS and a subquery in that order, so the
// names are looked for wherever that is. They are lowercased. A name defined
// anywhere in the statement counts everywhere in it, which is not how scopes
// work but only matters to a statement that hides a table it also reads.
func commonTables(toks []token) map[string]bool {
	out := map[string]bool{}
	for i := 1; i < len(toks); i++ {
		if !toks[i].is("AS") {
			continue
		}
		open := i + 1
		for open < len(toks) && toks[open].isAny("NOT", "MATERIALIZED") {
			open++
		}
		if open+1 >= len(toks) || toks[open].kind != punct || toks[open].text != "(" {
			continue
		}
		if first := toks[open+1]; !first.isAny("SELECT", "WITH", "VALUES", "FROM") && !(first.kind == punct && first.text == "(") {
			continue
		}
		before := i - 1
		// Past the names it gives its columns, if it gives any.
		if toks[before].kind == punct && toks[before].text == ")" {
			depth := 0
			for ; before >= 0; before-- {
				if toks[before].kind != punct {
					continue
				}
				if toks[before].text == ")" {
					depth++
				} else if toks[before].text == "(" {
					if depth--; depth == 0 {
						break
					}
				}
			}
			before--
		}
		if before >= 0 && toks[before].name() {
			out[strings.ToLower(toks[before].text)] = true
		}
	}
	return out
}

type tokenKind int

const (
	word   tokenKind = iota // a keyword or a name written bare
	quoted                  // a name in quotes; text is what the quotes hold
	punct                   // any other single character
	other                   // a string or a number: something, but nothing looked at
)

type token struct {
	kind tokenKind
	text string
	at   int // where it starts, in bytes
}

// name reports whether the token can be a name, or part of one.
func (t token) name() bool { return t.kind == word || t.kind == quoted }

// is reports whether the token is the keyword, which is given in capitals.
func (t token) is(keyword string) bool {
	return t.kind == word && strings.EqualFold(t.text, keyword)
}

func (t token) isAny(keywords ...string) bool {
	for _, keyword := range keywords {
		if t.is(keyword) {
			return true
		}
	}
	return false
}

// lex splits SQL into tokens, leaving out blanks and comments.
//
// Anything in double quotes or backticks is taken for a name. To MySQL double
// quotes hold a string, but a string cannot be where a table is named, and
// nowhere else does it matter which of the two it was.
func lex(sql string, lexis dialect.Lexis) []token {
	var toks []token
	for i := 0; i < len(sql); {
		c, at := sql[i], i
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
		case strings.HasPrefix(sql[i:], "--"), c == '#' && lexis.HashComments:
			if end := strings.IndexByte(sql[i:], '\n'); end >= 0 {
				i += end + 1
			} else {
				i = len(sql)
			}
		case strings.HasPrefix(sql[i:], "/*"):
			if end := strings.Index(sql[i+2:], "*/"); end >= 0 {
				i += end + 4
			} else {
				i = len(sql)
			}
		case c == '\'':
			_, i = quotedText(sql, i, lexis.BackslashEscapes)
			toks = append(toks, token{kind: other, at: at})
		case c == '"' || c == '`':
			var text string
			text, i = quotedText(sql, i, lexis.BackslashEscapes)
			toks = append(toks, token{kind: quoted, text: text, at: at})
		case c == '$' && lexis.DollarQuotes && dollarTag(sql[i:]) != "":
			tag := dollarTag(sql[i:])
			if end := strings.Index(sql[i+len(tag):], tag); end >= 0 {
				i += end + 2*len(tag)
			} else {
				i = len(sql)
			}
			toks = append(toks, token{kind: other, at: at})
		case wordStart(c):
			start := i
			for i < len(sql) && (wordStart(sql[i]) || digit(sql[i]) || sql[i] == '$') {
				i++
			}
			// E'...' is a string in which a backslash escapes, whatever else is so.
			if i < len(sql) && sql[i] == '\'' && strings.EqualFold(sql[start:i], "E") {
				_, i = quotedText(sql, i, true)
				toks = append(toks, token{kind: other, at: at})
				break
			}
			toks = append(toks, token{kind: word, text: sql[start:i], at: at})
		case digit(c):
			// With the letters of 1e9 and 0xFF, and the point of 1.5.
			for i < len(sql) && (wordStart(sql[i]) || digit(sql[i]) || (sql[i] == '.' && i+1 < len(sql) && digit(sql[i+1]))) {
				i++
			}
			toks = append(toks, token{kind: other, at: at})
		default:
			toks = append(toks, token{kind: punct, text: sql[i : i+1], at: at})
			i++
		}
	}
	return toks
}

// quotedText reads what starts with the quote at start, and returns what the
// quotes hold and where the SQL goes on. A quote inside is written twice, or
// after a backslash where that escapes. Left open, it runs to the end.
func quotedText(sql string, start int, backslash bool) (text string, next int) {
	quote := sql[start]
	var b strings.Builder
	for i := start + 1; i < len(sql); i++ {
		switch c := sql[i]; {
		case c == '\\' && backslash && i+1 < len(sql):
			i++
			b.WriteByte(sql[i])
		case c != quote:
			b.WriteByte(c)
		case i+1 < len(sql) && sql[i+1] == quote:
			i++
			b.WriteByte(quote)
		default:
			return b.String(), i + 1
		}
	}
	return b.String(), len(sql)
}

// dollarTag returns the $tag$ or $$ that s starts with, or nothing when it
// starts with something else, such as the $1 of a bound argument.
func dollarTag(s string) string {
	for i := 1; i < len(s); i++ {
		switch c := s[i]; {
		case c == '$':
			return s[:i+1]
		case wordStart(c), digit(c) && i > 1:
		default:
			return ""
		}
	}
	return ""
}

// wordStart reports whether a name written bare can begin with c. Every byte
// of a character outside ASCII can: names are in whatever language their
// authors write.
func wordStart(c byte) bool {
	return c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

func digit(c byte) bool { return c >= '0' && c <= '9' }
