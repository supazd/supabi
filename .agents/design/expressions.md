# Standard expressions

The expression of a calculated field can be written in one of two ways: with the platform's own functions (standard expressions), or with the data source's own SQL (native expressions). This document describes the language, semantics and implementation of standard expressions. The field model is in [Dataset model](dataset.md).

## 1. Role

A native expression is bound to one kind of database. When the data source changes, every calculated field has to be rewritten. The system cannot read it, so a person has to pick the type, and errors are known only when the database executes it.

A standard expression is a small language defined by the platform, made up only of operators and a set of functions. The same expression means the same thing on every database, and it is written as that database's SQL only when the query is compiled. As a result:

- Nothing needs to change when the data source changes.
- The system can read it: before saving, it can point out an error and its position, and the result type is inferred from the expression.
- The person writing it does not need to know which database is behind it.

It does not parse a database's SQL. The constraint in [Architecture overview](architecture.md) that "the design avoids parsing multiple SQL dialects" still holds: what is parsed here is a syntax the platform defines itself.

Source SQL is still written in the data source's dialect. When a dataset whose source is hand-written SQL changes data source, the SQL still has to be changed; what standard expressions save is the calculated-field part.

## 2. Two ways to write

A field's `syntax` says which language `expr` uses:

| `syntax` | Meaning |
|---|---|
| `"standard"` | Standard expression |
| Omitted | Native expression: spliced into the SQL as is, with only `${internal ID}` replaced by the SQL of the referenced field. The whole expression is put in brackets, so an `OR` at its top cannot take in a condition the field is compared with or ANDed to, the row filter included |

A calculated field created in the UI uses a standard expression by default. Fields created before standard expressions were introduced have no `syntax` and are treated as native; they are not converted automatically.

The two kinds of field can reference each other.

One expression cannot mix the two ways of writing: a function with the same name (`ROUND`, `SUBSTR`) can take different arguments or have different semantics on the platform and in the database, and when they are mixed there is no way to tell which one is meant. When a standard expression really does need a piece of the database's own SQL, mark it off explicitly with `NATIVE()`, see section 6.

## 3. Language

```
IF(${Order amount} >= 1000, 'Large order', 'Small order')
SUM(${Order amount}) / COUNT_DISTINCT(${User ID})
CASE WHEN ${Status} = 'paid' AND ${Note} IS NOT NULL THEN 1 ELSE 0 END
```

| Element | Syntax |
|---|---|
| Field | `${name}`, replaced with `${internal ID}` when stored, with the same rules as section 6.4 of [Dataset model](dataset.md) |
| Text | Single quotes; a quote itself is written twice: `'it''s'` |
| Number | `12`, `3.5` |
| Other literals | `TRUE`, `FALSE`, `NULL` |
| Arithmetic | `+` `-` `*` `/` `%`, and unary `-` |
| Comparison | `=` `<>` (or `!=`) `<` `<=` `>` `>=` |
| Logic | `AND` `OR` `NOT` |
| Condition | `x IN (a, b)`, `x BETWEEN a AND b`, `x IS NULL`, and the `NOT` form of each |
| Branch | `CASE WHEN condition THEN value … ELSE value END`, or `CASE x WHEN value THEN value … END` |
| Function | `name(argument, …)` |

Keywords and function names are case-insensitive. There are no double quotes or backticks: text uses only single quotes, and fields use only `${}`. A bare word is not a valid expression, so the mistake of writing a column name straight into an expression can be pointed out at parse time.

An expression is at most 20,000 bytes long, and brackets, function calls, `NOT` and minus signs nest at most 200 deep; beyond that it is refused with `expr_too_long` or `expr_too_deep`. The parser reads nesting by calling itself, and a Go stack that runs out ends the whole process rather than failing the one request.

### 3.1 Types

The type of a value is one of the field's seven logical types. During checking:

- Arithmetic applies only to numbers. An integer combined with a decimal gives a decimal; if a float takes part, the result is a float.
- For comparisons, `IN`, `BETWEEN`, and the branches of `CASE` and `IF`, both sides must be the same type; numeric types can be mixed.
- Where a date is needed, a text literal such as `'2026-01-31'` is read as a date.
- The type of `NULL` and `NATIVE()` is unknown, so they can appear anywhere.

The type of the expression is derived from these. The field's declared `type` must agree with it (numeric types count as agreeing), otherwise it cannot be saved. When an expression contains `NATIVE()` and the type cannot be inferred, the declared type wins.

### 3.2 Per row and aggregate

An aggregate function turns a group of rows into one value. During checking:

- The expression of a dimension or a measure cannot aggregate, and cannot reference a metric.
- The expression of a metric must aggregate.
- A per-row value cannot be placed directly together with an aggregated value: `SUM(${Amount}) / ${Quantity}` is wrong.
- Aggregates cannot be nested.

## 4. Semantics

Where databases disagree, the platform fixes one behavior, and each dialect implements it.

| Item | Convention |
|---|---|
| Division | No truncation: dividing two integers keeps the decimals. A divisor of 0 gives null and raises no error |
| Modulo | Integers only. A divisor of 0 gives null |
| `CONCAT` | If any part is null, the result is null. It accepts only text; convert numbers and dates with `TO_STRING` first |
| Text length and position | Counted in characters, and each Chinese character counts as one. Positions start at 1 |
| `ROUND` | Decimals round half up. The number of digits must be written directly as an integer |
| `TO_INTEGER` | Drops the fractional part and does not round |
| Taking the date or a part from a time | Convert to the time zone used by the query first, then take it. The result is the same whether the column stores a time without a time zone or an instant |
| `TODAY()` | The current day in the time zone used by the query, computed by the server at compile time and written as a literal |
| `WEEKDAY` | Monday is 1, Sunday is 7 |
| `DATE_TRUNC` with `'week'` | Which day a week starts on follows the workspace settings |
| `DATE_ADD` | A quarter is 3 months and a week is 7 days. If the result overflows past the end of a month, the last day of that month is used |
| `DATE_DIFF` | How many unit boundaries are crossed from start to end: January 31 to February 1 is a difference of 1 month |
| Comparing two times | Compared as instants, regardless of how each is stored |

Where consistency is not guaranteed:

- Whether text comparison is case-sensitive is decided by the database's collation.
- An expression of Boolean type returns 0 or 1 on databases without a Boolean type (MySQL, StarRocks, Doris) and on ClickHouse.
- How many digits `TO_STRING` shows for a decimal.
- Which way `ROUND` goes when a float is exactly halfway between two values.

## 5. Functions

### 5.1 Core functions

Every database supports them, with the same results.

| Category | Functions |
|---|---|
| Aggregates | `SUM` `AVG` `MIN` `MAX` `COUNT` (counts rows with no argument or `*`) `COUNT_DISTINCT` (can also be written as `COUNT(DISTINCT x)`) |
| Conditions and nulls | `IF` `COALESCE` `IFNULL` `NULLIF` |
| Numbers | `ABS` `ROUND` `FLOOR` `CEIL` `MOD` `POWER` `SQRT` |
| Text | `CONCAT` `UPPER` `LOWER` `TRIM` `LENGTH` `SUBSTR` `LEFT` `RIGHT` `REPLACE` `CONTAINS` `STARTS_WITH` `ENDS_WITH` |
| Dates and times | `TODAY` `DATE` `YEAR` `QUARTER` `MONTH` `DAY` `HOUR` `MINUTE` `WEEKDAY` `DATE_TRUNC` `DATE_ADD` `DATE_DIFF` |
| Conversions | `TO_STRING` `TO_INTEGER` `TO_DECIMAL` `TO_FLOAT` |

The arguments and description of each function are in the function panel of the UI; the text is in `web/apps/app/src/i18n/functions.*.ts`.

### 5.2 Extended functions

Not every database has them, and some do not guarantee that every detail is the same. A field that uses an extended function is not guaranteed to move to another data source.

| Function | Description | Databases without support |
|---|---|---|
| `MEDIAN` | Median. Algorithms differ slightly between databases | MySQL |
| `REGEXP_MATCH` | Regular expression match. Regular expression syntax differs somewhat between databases | None |

A function the data source does not support:

- Does not appear in the function panel or in completion (`GET /datasources/{id}/functions` returns only the available ones).
- Gets `function_unavailable` when an expression that uses it is checked or saved, naming the function.
- After the data source changes, a field that uses it gets the same error at query compile time, instead of an unreadable error from the database.

## 6. `NATIVE()`

```
IF(${Amount} > 100, NATIVE('json_extract({0}, ''$.tier'')', ${Extra info}), 'Small order')
```

The first argument is a piece of SQL text written out directly, in which `{0}` and `{1}` stand for the arguments that follow. It is output as is, the system does not check it, and its type is unknown.

When an expression has `NATIVE()`, the system knows the field contains a non-portable piece; the check endpoint returns `native: true`, and the UI shows a notice.

## 7. Implementation

```
internal/expr       parse, type check, write as SQL
internal/dialect    how each database writes each basic function (functions.go)
internal/dataset    reads expressions during validation; Spec.FieldSQL takes one of two paths by syntax
internal/query      supplies the dialect, time zone, week start day and today's date at compile time
```

1. **Parse**: a hand-written recursive descent parser that produces a syntax tree. Each node records its position in the expression.
2. **Check** (`expr.Check`): infers the type, whether it aggregates, which fields it references and which functions it uses. It does not depend on the database, so `Spec.Validate` does it.
3. **Output** (`Checked.SQL`): walks the syntax tree, breaks each platform function down into the dialect's basic functions and writes them out.

Platform functions and the dialect's basic functions are not one to one. `DATE_DIFF('month', a, b)` is broken down into the year difference times 12 plus the month difference, so a dialect only needs to be able to take the year and the month; `IF` is written directly as `CASE WHEN`, with no involvement from the dialect. The dialect interface therefore stays small:

```go
type Functions interface {
    Function(name string) (FunctionWriter, bool)
}
```

`standardFunctions` is how most databases write things, and each dialect overrides only where it differs. A form of `nil` means the database has no way to compute it. In the function catalog, each platform function declares which basic functions it depends on (`needs`), and from this follows whether it is available on a given database.

### 7.1 Adding a function

1. In the catalog in `internal/expr/functions.go`, add an entry: argument types, result type, the basic functions it depends on.
2. In `internal/expr/render.go`, say how to write it with basic functions. If it corresponds directly to one basic function, add a row to the `direct` table.
3. If a new basic function is needed, add it to `standardFunctions` in `internal/dialect/functions.go`, and override it for the dialects that write it differently.
4. In `internal/conformance/expressions.go`, add test cases: give its results on the five rows of test data. Every database must get the same result.
5. Add the description in `functions.*.ts` for both languages.

Once someone uses a semantic it is hard to change, so the expected values in step 4 must be settled first.

### 7.2 Connecting a new database

Implement the dialect's `Function`: start from `standardFunctions` and override what is written differently. Then run the conformance tests; whatever in the `expressions` group fails is what needs overriding.

### 7.3 Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /datasources/{id}/functions` | The functions available on this data source |
| `POST /datasources/{id}/check-expression` | Reads an expression in its written form (fields referenced by name) and returns the type, or the error and its position |

The check endpoint does not access the database. The editing UI calls it as the user types, fills in the field type with the returned type, and marks errors at the returned position.

## 8. Not done

| Item | Notes |
|---|---|
| Window functions | They involve the semantics of grouping and ordering; to be considered together with the derived calculations of the query IR |
| Time literals and time formatting | Format strings differ between databases; the platform needs to define its own format syntax first |
| Array, JSON and geo functions | Databases differ a lot; use `NATIVE()` for now |
| `GREATEST` / `LEAST` | Databases behave differently with nulls; the semantics need to be defined first |
| Automatically converting existing native expressions to standard expressions | Needs parsing the SQL of each dialect |
| Free-form expression measures at the chart level | This language can be reused directly; see [Deferred items](../backlog.md) |
