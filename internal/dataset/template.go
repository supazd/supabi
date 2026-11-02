package dataset

import (
	"strings"
)

// Template is source SQL split around its parameters.
//
//	SELECT * FROM t WHERE dt = {{biz_date}} [[ AND region IN {{regions}} ]]
//
// {{name}} becomes a bound argument, never text, so a parameter can only stand
// for a value. A [[ ... ]] block is dropped when a parameter inside it has no
// value.
//
// Only SQL itself is read for this. Inside a string, a quoted name or a
// comment, braces and brackets are what they would be to the database: text.
// So '{{status}}' is a string that says {{status}}, which may well be a value
// someone's data has, and a line that is commented out asks for no parameter.
// A parameter is a value by itself and is written without quotes.
type Template struct {
	parts []templatePart
}

type templatePart struct {
	text string
	// pos is where text starts in the SQL the template was parsed from.
	pos      int
	param    string         // set for a {{name}} placeholder
	optional []templatePart // set for a [[ ... ]] block
}

// ParseTemplate splits SQL into literal text, placeholders and optional blocks.
func ParseTemplate(sql string) (*Template, error) {
	parts, rest, err := parseParts(sql, 0, false, plainText(sql))
	if err != nil {
		return nil, err
	}
	if rest != "" {
		return nil, Errorf("template_unbalanced", nil, "unexpected ]] in the SQL")
	}
	return &Template{parts: parts}, nil
}

// parseParts parses s, which starts at offset pos of the whole SQL.
func parseParts(s string, pos int, inOptional bool, plain [][2]int) (parts []templatePart, rest string, err error) {
	whole := len(s) + pos
	for len(s) > 0 {
		pos = whole - len(s)
		next := strings.IndexAny(s, "{[]")
		if next < 0 {
			parts = append(parts, templatePart{text: s, pos: pos})
			break
		}
		switch {
		case inside(plain, pos+next):
			// Not template syntax here, whatever it looks like.
			parts = append(parts, templatePart{text: s[:next+1], pos: pos})
			s = s[next+1:]
		case strings.HasPrefix(s[next:], "{{"):
			end := strings.Index(s[next:], "}}")
			if end < 0 {
				return nil, "", Errorf("template_unbalanced", nil, "a {{ in the SQL is never closed")
			}
			name := strings.TrimSpace(s[next+2 : next+end])
			if !paramNamePattern.MatchString(name) {
				return nil, "", Errorf("invalid_param_name", []string{"name", name}, "invalid parameter name %q in the SQL", name)
			}
			parts = append(parts, templatePart{text: s[:next], pos: pos}, templatePart{param: name})
			s = s[next+end+2:]
		case strings.HasPrefix(s[next:], "[["):
			if inOptional {
				return nil, "", Errorf("template_nested_optional", nil, "[[ ]] blocks cannot be nested")
			}
			inner, after, err := parseParts(s[next+2:], pos+next+2, true, plain)
			if err != nil {
				return nil, "", err
			}
			parts = append(parts, templatePart{text: s[:next], pos: pos}, templatePart{optional: inner})
			s = after
		case strings.HasPrefix(s[next:], "]]"):
			if !inOptional {
				return parts, s[next:], nil
			}
			parts = append(parts, templatePart{text: s[:next], pos: pos})
			return parts, s[next+2:], nil
		default:
			// A lone brace or bracket is ordinary SQL (array subscripts, JSON).
			parts = append(parts, templatePart{text: s[:next+1], pos: pos})
			s = s[next+1:]
		}
	}
	if inOptional {
		return nil, "", Errorf("template_unbalanced", nil, "a [[ in the SQL is never closed")
	}
	return parts, "", nil
}

// ParamNames lists the parameters the template uses, without duplicates.
func (t *Template) ParamNames() []string {
	seen := map[string]bool{}
	var names []string
	var walk func([]templatePart)
	walk = func(parts []templatePart) {
		for _, p := range parts {
			if p.param != "" && !seen[p.param] {
				seen[p.param] = true
				names = append(names, p.param)
			}
			walk(p.optional)
		}
	}
	walk(t.parts)
	return names
}

// Render writes the SQL. text receives literal SQL and where it starts in the
// SQL that was parsed; bind receives a parameter name. A missing value inside an
// optional block drops the block; outside one it is the caller's error to
// report, so Render returns the name.
func (t *Template) Render(has func(name string) bool, text func(sql string, pos int), bind func(name string)) (missing string) {
	for _, p := range t.parts {
		switch {
		case p.optional != nil:
			complete := true
			for _, inner := range p.optional {
				if inner.param != "" && !has(inner.param) {
					complete = false
				}
			}
			if complete {
				for _, inner := range p.optional {
					if inner.param != "" {
						bind(inner.param)
					} else {
						text(inner.text, inner.pos)
					}
				}
			}
		case p.param != "":
			if !has(p.param) {
				return p.param
			}
			bind(p.param)
		default:
			text(p.text, p.pos)
		}
	}
	return ""
}

// plainText finds the stretches of SQL that are not SQL to this template:
// strings, quoted names and comments, each from its first character to the
// one after its last. A quote is escaped by doubling it, as the standard has it.
func plainText(sql string) [][2]int {
	var out [][2]int
	for i := 0; i < len(sql); i++ {
		start := i
		switch c := sql[i]; {
		case c == '-' && strings.HasPrefix(sql[i:], "--"):
			if end := strings.IndexByte(sql[i:], '\n'); end >= 0 {
				i += end
			} else {
				i = len(sql)
			}
		case c == '/' && strings.HasPrefix(sql[i:], "/*"):
			if end := strings.Index(sql[i+2:], "*/"); end >= 0 {
				i += end + 3
			} else {
				i = len(sql)
			}
		case c == '\'' || c == '"' || c == '`':
			i++
			for i < len(sql) {
				if sql[i] != c {
					i++
				} else if i+1 < len(sql) && sql[i+1] == c {
					i += 2
				} else {
					break
				}
			}
		default:
			continue
		}
		out = append(out, [2]int{start, min(i+1, len(sql))})
	}
	return out
}

// inside reports whether a position is in one of the stretches.
func inside(stretches [][2]int, at int) bool {
	for _, stretch := range stretches {
		if stretch[0] <= at && at < stretch[1] {
			return true
		}
	}
	return false
}
