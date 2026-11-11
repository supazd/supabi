// Package exports generates and retains background SQL exports.
package exports

import (
	"archive/zip"
	"bufio"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/supazd/supabi/internal/datasource"
)

var (
	ErrRowLimit    = errors.New("export_row_limit")
	ErrFileLimit   = errors.New("export_file_limit")
	ErrCellLimit   = errors.New("export_cell_limit")
	ErrColumnLimit = errors.New("export_column_limit")
)

// Excel limits: https://support.microsoft.com/en-us/excel/excel-specifications-and-limits
const sheetRows = 1048576
const sheetColumns = 16384

type Writer struct {
	format                         string
	columns                        []datasource.Column
	output                         *countWriter
	csv                            *csv.Writer
	zip                            *zip.Writer
	sheet                          *bufio.Writer
	sheets, sheetRow, rowsPerSheet int
	Rows                           int64
	maxRows                        int64
}

type countWriter struct {
	out          io.Writer
	count, limit int64
}

func (w *countWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.limit-w.count {
		return 0, ErrFileLimit
	}
	n, err := w.out.Write(p)
	w.count += int64(n)
	return n, err
}

func NewWriter(out io.Writer, format string, maxRows, maxBytes int64) (*Writer, error) {
	w := &Writer{format: format, output: &countWriter{out: out, limit: maxBytes}, maxRows: maxRows, rowsPerSheet: sheetRows}
	switch format {
	case "csv":
		// Excel recognises UTF-8 reliably with a BOM. Keep embedded CR/LF
		// characters intact instead of normalising the content of text cells.
		if _, err := io.WriteString(w.output, "\xef\xbb\xbf"); err != nil {
			return nil, err
		}
		w.csv = csv.NewWriter(w.output)
	case "xlsx":
		w.zip = zip.NewWriter(w.output)
	default:
		return nil, errors.New("invalid export format")
	}
	return w, nil
}

func (w *Writer) Start(columns []datasource.Column) error {
	w.columns = columns
	if w.format == "xlsx" {
		if len(columns) > sheetColumns {
			return ErrColumnLimit
		}
		return w.newSheet()
	}
	header := make([]string, len(columns))
	for i, c := range columns {
		header[i] = safeCSV(c.Name)
	}
	return w.csv.Write(header)
}

func (w *Writer) WriteRow(row []any) error {
	if w.Rows >= w.maxRows {
		return ErrRowLimit
	}
	if len(row) != len(w.columns) {
		return errors.New("export column count changed")
	}
	if w.csv != nil {
		values := make([]string, len(row))
		for i, v := range row {
			if v == nil {
				continue
			}
			if f, ok := v.(float64); ok {
				// Written out in full: Go's own way turns to an exponent from
				// a million up and below a ten-thousandth, which reads badly
				// and which not every program that takes the file understands.
				values[i] = strconv.FormatFloat(f, 'f', -1, 64)
			} else {
				values[i] = fmt.Sprint(v)
			}
			if !w.columns[i].Type.Numeric() || !number.MatchString(values[i]) {
				values[i] = safeCSV(values[i])
			}
		}
		if err := w.csv.Write(values); err != nil {
			return err
		}
	} else {
		if w.sheetRow >= w.rowsPerSheet {
			if err := w.newSheet(); err != nil {
				return err
			}
		}
		if err := w.xlsxRow(row, false); err != nil {
			return err
		}
	}
	w.Rows++
	return nil
}

// Formula-looking text is deliberately text in spreadsheet applications.
func safeCSV(s string) string {
	trimmed := strings.TrimLeft(s, " \t\r\n")
	if strings.ContainsAny(s[:min(len(s), 1)], "\t\r\n") || (trimmed != "" && strings.ContainsAny(trimmed[:1], "=+-@")) {
		return "'" + s
	}
	return s
}

func (w *Writer) Bytes() int64 { return w.output.count }

func (w *Writer) Close() error {
	if w.csv != nil {
		w.csv.Flush()
		return w.csv.Error()
	}
	if err := w.endSheet(); err != nil {
		return err
	}
	if err := w.metadata(); err != nil {
		return err
	}
	return w.zip.Close()
}

const xmlHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
const spreadsheetNS = `http://schemas.openxmlformats.org/spreadsheetml/2006/main`
const relationNS = `http://schemas.openxmlformats.org/officeDocument/2006/relationships`

func (w *Writer) newSheet() error {
	if err := w.endSheet(); err != nil {
		return err
	}
	w.sheets++
	w.sheetRow = 0
	f, err := w.zip.Create(fmt.Sprintf("xl/worksheets/sheet%d.xml", w.sheets))
	if err != nil {
		return err
	}
	w.sheet = bufio.NewWriterSize(f, 64<<10)
	if _, err := fmt.Fprintf(w.sheet, `%s<worksheet xmlns="%s"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>`, xmlHeader, spreadsheetNS); err != nil {
		return err
	}
	header := make([]any, len(w.columns))
	for i, c := range w.columns {
		header[i] = c.Name
	}
	return w.xlsxRow(header, true)
}

func (w *Writer) endSheet() error {
	if w.sheet == nil {
		return nil
	}
	_, err := io.WriteString(w.sheet, `</sheetData></worksheet>`)
	if err == nil {
		err = w.sheet.Flush()
	}
	w.sheet = nil
	return err
}

var number = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
var escapedExcel = regexp.MustCompile(`_x[0-9A-Fa-f]{4}_`)

func excelText(s string) (string, error) {
	if len(utf16.Encode([]rune(s))) > 32767 {
		return "", ErrCellLimit
	}
	// OOXML's escaped characters also preserve controls XML cannot contain.
	s = escapedExcel.ReplaceAllStringFunc(s, func(v string) string { return "_x005F_" + v[1:] })
	var out strings.Builder
	for _, r := range s {
		if r < 32 && r != '\n' && r != '\t' || r == '\ufffe' || r == '\uffff' {
			fmt.Fprintf(&out, "_x%04X_", r)
		} else {
			out.WriteRune(r)
		}
	}
	return out.String(), nil
}

// Values beyond Excel's 15 significant digits remain text instead of being
// silently rounded. Declared string columns always remain text, including IDs.
func excelNumber(s string) bool {
	if !number.MatchString(s) {
		return false
	}
	mantissa, _, _ := strings.Cut(strings.ToLower(s), "e")
	digits := strings.TrimLeft(strings.ReplaceAll(strings.TrimLeft(mantissa, "+-"), ".", ""), "0")
	n, err := strconv.ParseFloat(s, 64)
	// ParseFloat can return zero without an error when a nonzero decimal
	// underflows. Only an all-zero mantissa may become a numeric zero cell.
	return len(digits) <= 15 && err == nil && excelRange(n) && (n == 0) == (digits == "")
}

// excelRange is zero or a normal double below Excel's largest number.
func excelRange(n float64) bool {
	a := math.Abs(n)
	return a == 0 || a >= 2.2250738585072014e-308 && a < 1e308
}

func columnName(n int) string {
	s := ""
	for n++; n > 0; n = (n - 1) / 26 {
		s = string(rune('A'+(n-1)%26)) + s
	}
	return s
}

func (w *Writer) xlsxRow(row []any, header bool) error {
	w.sheetRow++
	if _, err := fmt.Fprintf(w.sheet, `<row r="%d">`, w.sheetRow); err != nil {
		return err
	}
	for i, v := range row {
		if v == nil {
			continue
		}
		ref := columnName(i) + strconv.Itoa(w.sheetRow)
		text, typ, style := fmt.Sprint(v), "inlineStr", 0
		if header {
			style = 1
		} else {
			kind := w.columns[i].Type
			if f, ok := v.(float64); ok && kind.Numeric() {
				// A double is already binary-rounded: Excel keeping 15 of its
				// 17 shortest digits loses nothing the source meant, unlike the
				// digits of a decimal or big integer string.
				if excelRange(f) {
					text, typ = strconv.FormatFloat(f, 'g', -1, 64), "n"
				}
			} else if kind.Numeric() && excelNumber(text) {
				typ = "n"
			}
			if b, ok := v.(bool); ok {
				typ = "b"
				if b {
					text = "1"
				} else {
					text = "0"
				}
			}
			if kind.Temporal() {
				layout := "2006-01-02"
				style = 2
				if kind == datasource.Timestamp {
					layout = "2006-01-02T15:04:05"
					style = 3
				}
				if date, err := time.Parse(layout, text); err == nil && date.Year() >= 1900 && date.Year() <= 9999 {
					// Unix seconds avoid time.Duration's 290-year range. Excel includes a fictitious 1900-02-29.
					serial := float64(date.Unix()-time.Date(1899, 12, 31, 0, 0, 0, 0, time.UTC).Unix())/86400 + float64(date.Nanosecond())/86400e9
					if !date.Before(time.Date(1900, 3, 1, 0, 0, 0, 0, time.UTC)) {
						serial++
					}
					text, typ = strconv.FormatFloat(serial, 'f', 10, 64), "n"
				} else {
					style = 0
				}
			}
		}
		if _, err := fmt.Fprintf(w.sheet, `<c r="%s" s="%d" t="%s">`, ref, style, typ); err != nil {
			return err
		}
		if typ == "inlineStr" {
			s, err := excelText(text)
			if err != nil {
				return err
			}
			if _, err = io.WriteString(w.sheet, `<is><t xml:space="preserve">`); err != nil {
				return err
			}
			if err = xml.EscapeText(w.sheet, []byte(s)); err != nil {
				return err
			}
			if _, err = io.WriteString(w.sheet, `</t></is>`); err != nil {
				return err
			}
		} else {
			if _, err := fmt.Fprintf(w.sheet, `<v>%s</v>`, text); err != nil {
				return err
			}
		}
		if _, err := io.WriteString(w.sheet, `</c>`); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w.sheet, `</row>`)
	return err
}

func (w *Writer) metadata() error {
	write := func(name, text string) error {
		f, err := w.zip.Create(name)
		if err != nil {
			return err
		}
		_, err = io.WriteString(f, xmlHeader+text)
		return err
	}
	if err := write("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="`+relationNS+`/officeDocument" Target="xl/workbook.xml"/></Relationships>`); err != nil {
		return err
	}
	var workbook, rels, types strings.Builder
	fmt.Fprintf(&workbook, `<workbook xmlns="%s" xmlns:r="%s"><sheets>`, spreadsheetNS, relationNS)
	rels.WriteString(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	types.WriteString(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`)
	for i := 1; i <= w.sheets; i++ {
		fmt.Fprintf(&workbook, `<sheet name="Data %d" sheetId="%d" r:id="rId%d"/>`, i, i, i)
		fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>`, i, relationNS, i)
		fmt.Fprintf(&types, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, i)
	}
	workbook.WriteString(`</sheets></workbook>`)
	fmt.Fprintf(&rels, `<Relationship Id="styles" Type="%s/styles" Target="styles.xml"/></Relationships>`, relationNS)
	types.WriteString(`</Types>`)
	for _, part := range [][2]string{{"xl/workbook.xml", workbook.String()}, {"xl/_rels/workbook.xml.rels", rels.String()}, {"[Content_Types].xml", types.String()}, {"xl/styles.xml", stylesXML}} {
		if err := write(part[0], part[1]); err != nil {
			return err
		}
	}
	return nil
}

const stylesXML = `<styleSheet xmlns="` + spreadsheetNS + `"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
