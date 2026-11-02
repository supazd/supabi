package assistant

import (
	"math/big"
	"strings"
	"testing"
)

func TestEvaluate(t *testing.T) {
	values := map[string]*big.Rat{"a": big.NewRat(418476125, 100), "b": big.NewRat(30051204, 10)}
	cases := map[string]string{
		"a - b":             "1179640.85",
		"(a - b) / b * 100": "39.25436232",
		"a + b":             "7189881.65",
		"0.1 + 0.2":         "0.3",
		"-a + a":            "0",
		"1 / 3":             "0.3333333333",
		"2 / 3 / 1000":      "0.0006666666667",
		"10 / 4":            "2.5",
		"a × 2 − b ÷ 2":     "6866962.3",
		"12345678901 / 7":   "1763668414",
	}
	for expression, want := range cases {
		got, err := evaluate(expression, values)
		if err != nil {
			t.Errorf("%s: %v", expression, err)
			continue
		}
		if text := decimalText(got); text != want {
			t.Errorf("%s = %s, want %s", expression, text, want)
		}
	}
	for expression, want := range map[string]string{
		"a / (b - b)": "division by zero",
		"a + c":       "c is not among the inputs",
		"(a + b":      "not closed",
		"a b":         "more after its end",
		"a +":         "ends too soon",
		"* 2":         "has no place",
		"":            "empty",
	} {
		if _, err := evaluate(expression, values); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", expression, err, want)
		}
	}
}

// Inputs must be figures the answer's sources hold, written however they
// were; the result is a figure of its own source.
func TestCalculate(t *testing.T) {
	known := figures{1: cellsOf([]any{"华东", "4184761.25", "华南", "3005120.40", float64(0.1), int64(7)}), 2: {big.NewRat(5, 1)}}
	out, result := calculate(`{"expression":"(a - b) / b","inputs":{"a":{"label":"华东","value":4184761.25,"source":1},"b":{"label":"华南","value":"3005120.4","source":1}}}`, known)
	if out.Failed || out.Calculation == nil || out.Calculation.Result != "0.3925436232" || decimalText(result) != "0.3925436232" {
		t.Fatalf("out = %+v", out)
	}
	if out.Subject != "(华东 − 华南) ÷ 华南 = 0.3925436232" || out.Content != "(a - b) / b = 0.3925436232" || len(out.Calculation.Inputs) != 2 || out.Calculation.Inputs[1].Value != "3005120.4" {
		t.Errorf("out = %+v", out)
	}
	if out, _ := calculate(`{"expression":"x * 10 + y","inputs":{"x":{"label":"率","value":0.1,"source":1},"y":{"label":"上一步","value":5,"source":2}}}`, known); out.Failed || out.Calculation.Result != "6" {
		t.Errorf("a float and an earlier result: %+v", out)
	}
	for arguments, want := range map[string]string{
		`{"expression":"a","inputs":{"a":{"label":"x","value":4184761.26,"source":1}}}`: "has no figure 4184761.26",
		`{"expression":"a","inputs":{"a":{"label":"x","value":5,"source":3}}}`:          "does not have",
		`{"expression":"a","inputs":{"a":{"label":"x","value":"华东","source":1}}}`:       "not a number",
		`{"expression":"a","inputs":{"a":{"label":"x","value":"1/3","source":1}}}`:      "not a number",
		`{"expression":"a","inputs":{},"note":"x"}`:                                     "not what calculate takes",
		`{"expression":"a / 0","inputs":{"a":{"label":"x","value":7,"source":1}}}`:      "division by zero",
		`{"expression":"1234567","inputs":{}}`:                                          "uses no input",
		`{"expression":"7 * 2","inputs":{"a":{"label":"x","value":7,"source":1}}}`:      "uses no input",
	} {
		if out, _ := calculate(arguments, known); !out.Failed || !strings.Contains(out.Content, want) {
			t.Errorf("%s: %+v, want %q", arguments, out, want)
		}
	}
}
