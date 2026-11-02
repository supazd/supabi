package exports

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/datasource"
)

func zipParts(t *testing.T, b []byte) map[string]string {
	t.Helper()
	z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range z.File {
		r, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(r)
		_ = r.Close()
		if err != nil {
			t.Fatal(err)
		}
		out[f.Name] = string(raw)
		decoder := xml.NewDecoder(bytes.NewReader(raw))
		for {
			_, err := decoder.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				t.Fatalf("invalid XML %s: %v", f.Name, err)
			}
		}
	}
	return out
}

func TestCSVPreservesValuesAndProtectsFormulaText(t *testing.T) {
	var b bytes.Buffer
	w, err := NewWriter(&b, "csv", 20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	cols := []datasource.Column{{Name: "名称", Type: datasource.String}, {Name: "金额", Type: datasource.Decimal}, {Name: "空", Type: datasource.String}}
	if err = w.Start(cols); err != nil {
		t.Fatal(err)
	}
	for _, row := range [][]any{{"华东,\"订单\"\n下一行", "123456789012345678.123456", nil}, {" =SUM(A1:A2)", "-12.30", ""}} {
		if err = w.WriteRow(row); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(b.Bytes(), []byte{239, 187, 191}) {
		t.Fatal("missing UTF-8 BOM")
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(b.String(), "\ufeff"))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[1][0] != "华东,\"订单\"\n下一行" || rows[1][1] != "123456789012345678.123456" || rows[2][0] != "' =SUM(A1:A2)" || rows[2][1] != "-12.30" {
		t.Fatalf("CSV changed values: %#v", rows)
	}
}

func TestXLSXTypesPrecisionEscapesAndMultipleSheets(t *testing.T) {
	var b bytes.Buffer
	w, err := NewWriter(&b, "xlsx", 20, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	w.rowsPerSheet = 3 // one header and two data rows per sheet
	cols := []datasource.Column{{Name: "编号", Type: datasource.Integer}, {Name: "金额", Type: datasource.Decimal}, {Name: "名称", Type: datasource.String}, {Name: "日期", Type: datasource.Date}, {Name: "启用", Type: datasource.Boolean}, {Name: "空", Type: datasource.String}}
	if err = w.Start(cols); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err = w.WriteRow([]any{int64(123456789012345678), "12.30", "=1+1\x00_x0041_ & 中文", "2026-10-18", true, nil}); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	parts := zipParts(t, b.Bytes())
	sheet := parts["xl/worksheets/sheet1.xml"]
	for _, want := range []string{`t="inlineStr"><is><t xml:space="preserve">123456789012345678`, `<c r="B2" s="0" t="n"><v>12.30</v>`, `=1+1_x0000__x005F_x0041_ &amp; 中文`, `<c r="D2" s="2" t="n">`, `<c r="E2" s="0" t="b"><v>1</v>`, `state="frozen"`} {
		if !strings.Contains(sheet, want) {
			t.Errorf("missing %s in %s", want, sheet)
		}
	}
	if strings.Contains(sheet, "<f>") {
		t.Fatal("export text became a formula")
	}
	if strings.Count(sheet, "<row ") != 3 || strings.Count(parts["xl/worksheets/sheet2.xml"], "<row ") != 2 {
		t.Fatal("bad worksheet split")
	}
	if !strings.Contains(parts["xl/workbook.xml"], `sheetId="2"`) || !strings.Contains(parts["[Content_Types].xml"], "sheet2.xml") {
		t.Fatal("missing worksheet relationships")
	}
}

func TestXLSXPreservesNonzeroDecimalsBelowExcelRange(t *testing.T) {
	cases := []struct {
		value, cellType string
	}{
		{"1e-400", "inlineStr"},
		{"-1e-400", "inlineStr"},
		// PostgreSQL numeric returns this expanded form for 1e-400.
		{"0." + strings.Repeat("0", 399) + "1", "inlineStr"},
		{"2e-308", "inlineStr"},
		{"2.2250738585072e-308", "inlineStr"},
		// The smallest normal value rounded up to 15 significant digits.
		{"2.22507385850721e-308", "n"},
		{"0", "n"},
		{"-0", "n"},
		{"0.000", "n"},
		{"0e-400", "n"},
	}
	var b bytes.Buffer
	w, err := NewWriter(&b, "xlsx", int64(len(cases)), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Start([]datasource.Column{{Name: "exact", Type: datasource.Decimal}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		if err = w.WriteRow([]any{tc.value}); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	sheet := zipParts(t, b.Bytes())["xl/worksheets/sheet1.xml"]
	for i, tc := range cases {
		value := "<v>" + tc.value + "</v>"
		if tc.cellType == "inlineStr" {
			value = `<is><t xml:space="preserve">` + tc.value + `</t></is>`
		}
		want := fmt.Sprintf(`<c r="A%d" s="0" t="%s">%s</c>`, i+2, tc.cellType, value)
		if !strings.Contains(sheet, want) {
			t.Errorf("decimal %q did not retain its value and cell type %s", tc.value, tc.cellType)
		}
	}
}

func TestXLSXWritesComputedFloatsAsNumbers(t *testing.T) {
	tenth, fifth := 0.1, 0.2 // variables: constant arithmetic would be exact
	cases := []struct {
		value    any
		cellType string
		text     string
	}{
		// Averages and sums of doubles carry 16-17 shortest digits.
		{tenth + fifth, "n", "0.30000000000000004"},
		{1.0 / 3, "n", "0.3333333333333333"},
		{-2.5e300, "n", "-2.5e+300"},
		{0.0, "n", "0"},
		{1e308, "inlineStr", "1e+308"},
		{5e-324, "inlineStr", "5e-324"},
		// The same digits as a decimal string are not a double, so they stay exact.
		{"0.30000000000000004", "inlineStr", "0.30000000000000004"},
	}
	var b bytes.Buffer
	w, err := NewWriter(&b, "xlsx", int64(len(cases)), 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if err = w.Start([]datasource.Column{{Name: "average", Type: datasource.Float}}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		if err = w.WriteRow([]any{tc.value}); err != nil {
			t.Fatal(err)
		}
	}
	if err = w.Close(); err != nil {
		t.Fatal(err)
	}
	sheet := zipParts(t, b.Bytes())["xl/worksheets/sheet1.xml"]
	for i, tc := range cases {
		value := "<v>" + tc.text + "</v>"
		if tc.cellType == "inlineStr" {
			value = `<is><t xml:space="preserve">` + tc.text + `</t></is>`
		}
		want := fmt.Sprintf(`<c r="A%d" s="0" t="%s">%s</c>`, i+2, tc.cellType, value)
		if !strings.Contains(sheet, want) {
			t.Errorf("%v: want %s in %s", tc.value, want, sheet)
		}
	}
}

func TestExportEmptyAndLimits(t *testing.T) {
	for _, format := range []string{"csv", "xlsx"} {
		t.Run(format, func(t *testing.T) {
			var b bytes.Buffer
			w, _ := NewWriter(&b, format, 1, 1<<20)
			if err := w.Start([]datasource.Column{{Name: "empty", Type: datasource.String}}); err != nil {
				t.Fatal(err)
			}
			if err := w.Close(); err != nil {
				t.Fatal(err)
			}
			if format == "xlsx" {
				parts := zipParts(t, b.Bytes())
				if strings.Count(parts["xl/worksheets/sheet1.xml"], "<row ") != 1 {
					t.Fatal("empty workbook lost headers")
				}
			}
			w, _ = NewWriter(io.Discard, format, 1, 1<<20)
			_ = w.Start([]datasource.Column{{Name: "n", Type: datasource.Integer}})
			_ = w.WriteRow([]any{1})
			if !errors.Is(w.WriteRow([]any{2}), ErrRowLimit) {
				t.Fatal("row limit not enforced")
			}
		})
	}
	w, _ := NewWriter(io.Discard, "xlsx", 1, 1<<20)
	_ = w.Start([]datasource.Column{{Name: "n", Type: datasource.String}})
	if !errors.Is(w.WriteRow([]any{strings.Repeat("界", 32768)}), ErrCellLimit) {
		t.Fatal("long cell silently truncated")
	}
	w, _ = NewWriter(io.Discard, "xlsx", 1, 1<<20)
	if !errors.Is(w.Start(make([]datasource.Column, 16385)), ErrColumnLimit) {
		t.Fatal("column limit not enforced")
	}
	w, _ = NewWriter(io.Discard, "csv", 1, 4)
	_ = w.Start([]datasource.Column{{Name: "long header"}})
	if !errors.Is(w.Close(), ErrFileLimit) {
		t.Fatal("file limit not enforced")
	}
}
