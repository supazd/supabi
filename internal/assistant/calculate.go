package assistant

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/supazd/supabi/internal/llm"
	"github.com/supazd/supabi/internal/store"
)

// The calculator the model works figures out with, which a chart does not
// show: the program does the arithmetic, in decimals, and every input must
// be a figure the answer has looked up. See .agents/design/ai-assistant.md 12.9.

const calculatorName = "calculate"

// significant is how many digits a result that does not end is given to.
const significant = 10

var calculatorTool = llm.Tool{
	Name: calculatorName,
	Description: `Works out a figure no chart shows, such as a difference, a growth rate or a share, from figures this answer has looked up or worked out. Write the expression with + - * / and parentheses, naming each figure it uses; give each name the figure's value exactly as its source has it, the source's number, and what the figure is. Constants such as 100 or 12 may be written in the expression. The result is a source of its own, to cite.
Do not add up averages, ratios or distinct counts. For a total, use the totals a result gives; do not take the sum of its rows for the whole when the result was cut short or the chart shows only the top few. Only do arithmetic: do not forecast or estimate.`,
	Parameters: json.RawMessage(`{"type":"object","properties":{` +
		`"expression":{"type":"string","description":"Such as (a - b) / b * 100."},` +
		`"inputs":{"type":"object","description":"By the names the expression uses.","additionalProperties":{"type":"object","properties":{` +
		`"label":{"type":"string","description":"What the figure is, such as East China revenue in March."},` +
		`"value":{"description":"The figure, as the source has it."},` +
		`"source":{"type":"integer","description":"The number of the source it comes from."}` +
		`},"required":["label","value","source"]}}` +
		`},"required":["expression","inputs"]}`),
}

// figures are what each source of an answer holds, by its number: the
// values a chart gave the model, or what a calculation came to.
type figures map[int][]*big.Rat

// cellsOf are the numbers among a source's values.
func cellsOf(values []any) []*big.Rat {
	var out []*big.Rat
	for _, v := range values {
		if r, ok := toNumber(v); ok {
			out = append(out, r)
		}
	}
	return out
}

// toNumber reads a number written as a number or as text, such as a
// decimal column's "100.50". A fraction is no figure.
func toNumber(v any) (*big.Rat, bool) {
	var text string
	switch n := v.(type) {
	case string:
		text = strings.TrimSpace(n)
	case json.Number:
		text = n.String()
	case float64:
		// As JSON writes it, which is what the model read: its exact binary
		// value would not equal the 0.1 the model copies.
		if math.IsInf(n, 0) || math.IsNaN(n) {
			return nil, false
		}
		text = strconv.FormatFloat(n, 'g', -1, 64)
	case float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		text = fmt.Sprint(n)
	default:
		return nil, false
	}
	if text == "" || strings.Contains(text, "/") {
		return nil, false
	}
	return new(big.Rat).SetString(text)
}

type calcInput struct {
	Label  string          `json:"label"`
	Value  json.RawMessage `json:"value"`
	Source int             `json:"source"`
}

// calculate works out what the model asked for, refusing inputs that are
// not in the sources it names.
func calculate(arguments string, known figures) (ToolResult, *big.Rat) {
	var req struct {
		Expression string               `json:"expression"`
		Inputs     map[string]calcInput `json:"inputs"`
	}
	dec := json.NewDecoder(strings.NewReader(arguments))
	dec.UseNumber()
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return refused("The arguments are not what calculate takes: " + err.Error())
	}
	calc := &store.Calculation{Expression: strings.TrimSpace(req.Expression), Inputs: []store.CalculationInput{}}
	values := map[string]*big.Rat{}
	names := make([]string, 0, len(req.Inputs))
	for name := range req.Inputs {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		in := req.Inputs[name]
		var raw any
		dec := json.NewDecoder(strings.NewReader(string(in.Value)))
		dec.UseNumber()
		_ = dec.Decode(&raw)
		value, ok := toNumber(raw)
		if !ok {
			return refused(fmt.Sprintf("Input %s is not a number: %s.", name, in.Value))
		}
		held, exists := known[in.Source]
		if !exists {
			return refused(fmt.Sprintf("Input %s names source [%d], which this answer does not have: inputs come from what this answer looked up or worked out.", name, in.Source))
		}
		if !slices.ContainsFunc(held, func(r *big.Rat) bool { return r.Cmp(value) == 0 }) {
			return refused(fmt.Sprintf("Source [%d] has no figure %s, given for input %s: copy each input exactly from its source.", in.Source, fmt.Sprint(raw), name))
		}
		values[name] = value
		calc.Inputs = append(calc.Inputs, store.CalculationInput{Name: name, Label: in.Label, Value: fmt.Sprint(raw), Source: in.Source})
	}
	// Constants alone would make a figure out of nothing.
	if !slices.ContainsFunc(tokenize(calc.Expression), func(t token) bool { return values[t.name] != nil }) {
		return refused("The expression uses no input: work out figures from those this answer looked up.")
	}
	result, err := evaluate(calc.Expression, values)
	if err != nil {
		return refused(err.Error())
	}
	calc.Result = decimalText(result)
	return ToolResult{Content: calc.Expression + " = " + calc.Result, Subject: labelled(calc), Calculation: calc}, result
}

func refused(why string) (ToolResult, *big.Rat) {
	return ToolResult{Content: why, Failed: true}, nil
}

// labelled is a calculation for people: its inputs by what they are.
func labelled(calc *store.Calculation) string {
	labels := map[string]string{}
	for _, in := range calc.Inputs {
		labels[in.Name] = cmp.Or(in.Label, in.Name)
	}
	var out strings.Builder
	for _, t := range tokenize(calc.Expression) {
		switch {
		case t.name != "":
			out.WriteString(cmp.Or(labels[t.name], t.name))
		case t.op == '*':
			out.WriteString(" × ")
		case t.op == '/':
			out.WriteString(" ÷ ")
		case t.op == '-':
			out.WriteString(" − ")
		case t.op == '+':
			out.WriteString(" + ")
		case t.op != 0:
			out.WriteRune(t.op)
		default:
			out.WriteString(t.number)
		}
	}
	return strings.TrimSpace(out.String()) + " = " + calc.Result
}

// decimalText writes a result exactly when it ends within a few places,
// and to as many significant digits otherwise.
func decimalText(r *big.Rat) string {
	if places, exact := r.FloatPrec(); exact && places <= significant {
		return r.FloatString(places)
	}
	abs := new(big.Rat).Abs(r)
	whole := new(big.Int).Quo(abs.Num(), abs.Denom())
	places := significant
	if whole.Sign() > 0 {
		places = max(0, significant-len(whole.String()))
	} else if f, _ := abs.Float64(); f > 0 {
		places = int(math.Floor(-math.Log10(f))) + significant
	}
	text := r.FloatString(places)
	if strings.Contains(text, ".") {
		text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
	}
	return text
}

// token is a piece of an expression: a number, a name, or an operator or
// parenthesis.
type token struct {
	number string
	name   string
	op     rune
}

// tokenize splits an expression into tokens, taking × ÷ and − for * / and -.
// Anything else it does not know is an operator the parser refuses.
func tokenize(expression string) []token {
	var out []token
	runes := []rune(expression)
	for i := 0; i < len(runes); {
		r := runes[i]
		switch {
		case unicode.IsSpace(r):
			i++
		case unicode.IsDigit(r) || r == '.':
			j := i
			for j < len(runes) && (unicode.IsDigit(runes[j]) || runes[j] == '.') {
				j++
			}
			out = append(out, token{number: string(runes[i:j])})
			i = j
		case unicode.IsLetter(r) || r == '_':
			j := i
			for j < len(runes) && (unicode.IsLetter(runes[j]) || unicode.IsDigit(runes[j]) || runes[j] == '_') {
				j++
			}
			out = append(out, token{name: string(runes[i:j])})
			i = j
		default:
			switch r {
			case '×':
				r = '*'
			case '÷':
				r = '/'
			case '−':
				r = '-'
			}
			out = append(out, token{op: r})
			i++
		}
	}
	return out
}

var errDivisionByZero = errors.New("division by zero")

// evaluate works an expression out in exact fractions.
func evaluate(expression string, values map[string]*big.Rat) (*big.Rat, error) {
	if expression == "" {
		return nil, errors.New("the expression is empty")
	}
	if len(expression) > 2000 {
		return nil, errors.New("the expression is too long")
	}
	p := &parser{tokens: tokenize(expression), values: values}
	result, err := p.sum()
	if err != nil {
		return nil, err
	}
	if p.at < len(p.tokens) {
		return nil, fmt.Errorf("the expression has more after its end: %q", p.describe(p.tokens[p.at]))
	}
	return result, nil
}

type parser struct {
	tokens []token
	at     int
	depth  int
	values map[string]*big.Rat
}

func (p *parser) peek() (token, bool) {
	if p.at < len(p.tokens) {
		return p.tokens[p.at], true
	}
	return token{}, false
}

func (p *parser) describe(t token) string {
	return cmp.Or(t.number, t.name, string(t.op))
}

// sum is terms added and taken away.
func (p *parser) sum() (*big.Rat, error) {
	left, err := p.product()
	if err != nil {
		return nil, err
	}
	for {
		t, ok := p.peek()
		if !ok || (t.op != '+' && t.op != '-') {
			return left, nil
		}
		p.at++
		right, err := p.product()
		if err != nil {
			return nil, err
		}
		if t.op == '+' {
			left = new(big.Rat).Add(left, right)
		} else {
			left = new(big.Rat).Sub(left, right)
		}
	}
}

// product is factors multiplied and divided.
func (p *parser) product() (*big.Rat, error) {
	left, err := p.factor()
	if err != nil {
		return nil, err
	}
	for {
		t, ok := p.peek()
		if !ok || (t.op != '*' && t.op != '/') {
			return left, nil
		}
		p.at++
		right, err := p.factor()
		if err != nil {
			return nil, err
		}
		if t.op == '*' {
			left = new(big.Rat).Mul(left, right)
			continue
		}
		if right.Sign() == 0 {
			return nil, errDivisionByZero
		}
		left = new(big.Rat).Quo(left, right)
	}
}

// factor is a number, an input, a sign before a factor, or a sum in parentheses.
func (p *parser) factor() (*big.Rat, error) {
	t, ok := p.peek()
	if !ok {
		return nil, errors.New("the expression ends too soon")
	}
	p.at++
	switch {
	case t.number != "":
		r, ok := new(big.Rat).SetString(t.number)
		if !ok {
			return nil, fmt.Errorf("%q is not a number", t.number)
		}
		return r, nil
	case t.name != "":
		r, ok := p.values[t.name]
		if !ok {
			return nil, fmt.Errorf("%s is not among the inputs", t.name)
		}
		return r, nil
	case t.op == '-' || t.op == '+':
		r, err := p.factor()
		if err != nil || t.op == '+' {
			return r, err
		}
		return new(big.Rat).Neg(r), nil
	case t.op == '(':
		if p.depth++; p.depth > 50 {
			return nil, errors.New("the expression nests too deep")
		}
		r, err := p.sum()
		if err != nil {
			return nil, err
		}
		p.depth--
		if closing, ok := p.peek(); !ok || closing.op != ')' {
			return nil, errors.New("a parenthesis is not closed")
		}
		p.at++
		return r, nil
	}
	return nil, fmt.Errorf("%q has no place there", p.describe(t))
}
