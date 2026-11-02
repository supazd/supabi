package sqlrefs

import (
	"slices"
	"strings"
	"testing"

	"github.com/supazd/supabi/internal/dialect"
)

func TestTables(t *testing.T) {
	postgres := dialect.Postgres{}.Lexis()
	mysql := dialect.MySQL{}.Lexis()
	clickhouse := dialect.ClickHouse{}.Lexis()
	cases := []struct {
		name  string
		lexis dialect.Lexis
		sql   string
		want  []string
	}{
		{"one table", postgres, `SELECT * FROM orders`, []string{"orders"}},
		{"with its schema", postgres, `select id from public.orders o where o.id > 1`, []string{"public.orders"}},
		{"three parts", postgres, `SELECT 1 FROM lake.sales.orders`, []string{"lake.sales.orders"}},
		{"joins", postgres, `SELECT * FROM orders o JOIN regions r ON o.region_id = r.id LEFT OUTER JOIN users AS u USING (user_id)`, []string{"orders", "regions", "users"}},
		{"commas", postgres, `SELECT * FROM orders o, regions r, users WHERE o.a IN (1, 2)`, []string{"orders", "regions", "users"}},
		{"a comma after a join's condition", postgres, `SELECT * FROM a JOIN b ON a.x = f(b.x, 1), c`, []string{"a", "b", "c"}},
		{"named once", postgres, `SELECT * FROM orders a JOIN orders b ON a.id = b.parent`, []string{"orders"}},
		{"quoted names", postgres, `SELECT * FROM "Sales Data"."2024 ""final""" JOIN "t.x" ON true`, []string{`Sales Data.2024 "final"`, "t.x"}},
		{"backticks", mysql, "SELECT * FROM `shop`.`order items` JOIN `a``b` ON 1", []string{"shop.order items", "a`b"}},
		{"names in other scripts", mysql, `SELECT * FROM 订单 JOIN 库.地区 ON 1`, []string{"订单", "库.地区"}},

		{"a subquery", postgres, `SELECT * FROM (SELECT * FROM orders WHERE paid) t JOIN (SELECT id FROM users) u ON true`, []string{"orders", "users"}},
		{"a subquery in a condition", postgres, `SELECT * FROM orders WHERE user_id IN (SELECT id FROM users) AND EXISTS (SELECT 1 FROM refunds r)`, []string{"orders", "users", "refunds"}},
		{"a subquery among the columns", postgres, `SELECT (SELECT max(dt) FROM calendar), a FROM orders`, []string{"calendar", "orders"}},
		{"joins in brackets", postgres, `SELECT * FROM (orders o JOIN regions r ON o.r = r.id) JOIN users u ON true`, []string{"orders", "regions", "users"}},
		{"unions", postgres, `SELECT a FROM x UNION ALL SELECT a FROM y EXCEPT (SELECT a FROM z)`, []string{"x", "y", "z"}},
		{"lateral", postgres, `SELECT * FROM orders o, LATERAL (SELECT * FROM items i WHERE i.order_id = o.id) x`, []string{"orders", "items"}},

		{"a common table", postgres, `WITH paid AS (SELECT * FROM orders WHERE paid) SELECT * FROM paid JOIN regions ON true`, []string{"orders", "regions"}},
		{"several, with columns", postgres, `WITH a (x, y) AS (SELECT 1, 2 FROM t1), B AS NOT MATERIALIZED (SELECT * FROM a) SELECT * FROM b, t2`, []string{"t1", "t2"}},
		{"a recursive one", postgres, `WITH RECURSIVE tree AS (SELECT * FROM nodes UNION ALL SELECT n.* FROM nodes n JOIN tree ON true) SELECT * FROM tree`, []string{"nodes"}},
		{"a schema's table of the same name", postgres, `WITH orders AS (SELECT * FROM raw.orders) SELECT * FROM orders`, []string{"raw.orders"}},

		{"a comment", postgres, "SELECT * FROM orders -- JOIN refunds\n/* FROM old_orders */ WHERE true", []string{"orders"}},
		{"a hash comment", mysql, "SELECT * FROM orders # FROM refunds\nWHERE 1", []string{"orders"}},
		{"no hash comment", postgres, "SELECT a #> '{b}' FROM orders", []string{"orders"}},
		{"a string", postgres, `SELECT 'it''s FROM refunds' FROM orders WHERE note = ' JOIN x '`, []string{"orders"}},
		{"a backslash in a string", mysql, `SELECT 'it\'s FROM refunds' FROM orders`, []string{"orders"}},
		{"a backslash that escapes nothing", postgres, `SELECT 'C:\' FROM orders`, []string{"orders"}},
		{"an escape string", postgres, `SELECT E'it\'s FROM refunds' FROM orders`, []string{"orders"}},
		{"a dollar string", postgres, `SELECT $q$ FROM refunds $q$, $$ JOIN x $$, $1 FROM orders`, []string{"orders"}},
		{"a column of the name", postgres, `SELECT orders, refunds.total FROM summary`, []string{"summary"}},

		{"a FROM that is not the clause", postgres, `SELECT EXTRACT(year FROM created_at), trim(both ' ' FROM name), a IS DISTINCT FROM b, c IS NOT DISTINCT FROM d FROM orders WHERE substring(x FROM 2) = 'a' AND a IS DISTINCT FROM b`, []string{"orders"}},
		{"a function", postgres, `SELECT * FROM generate_series(1, 10) g, orders, pg_catalog.unnest(ARRAY[1]) u JOIN LATERAL jsonb_each(o.doc) ON true`, []string{"orders"}},
		{"a file", postgres, `SELECT * FROM 'data.csv' JOIN orders ON true`, []string{"orders"}},
		{"values", postgres, `SELECT * FROM (VALUES (1, 2)) v (a, b), orders`, []string{"orders"}},
		{"dual", mysql, `SELECT 1 FROM DUAL`, nil},
		{"from first", postgres, `FROM orders SELECT count(*)`, []string{"orders"}},
		{"an index hint", mysql, `SELECT * FROM orders USE INDEX (a, b) STRAIGHT_JOIN users ON 1`, []string{"orders", "users"}},
		{"array join", clickhouse, `SELECT * FROM events FINAL ARRAY JOIN tags AS tag, ids AS id WHERE tag != ''`, []string{"events"}},
		{"clickhouse clauses", clickhouse, `SELECT * FROM events PREWHERE a, b IN (SELECT id FROM users) GROUP BY a, b`, []string{"events", "users"}},

		{"parameters", postgres, "SELECT * FROM orders o WHERE o.dt >= {{start_date}}\n[[ AND o.region IN {{regions}} ]]", []string{"orders"}},
		{"a join that may be left out", postgres, `SELECT * FROM orders o [[ JOIN regions r ON r.id = o.r AND r.name = {{region}} ]] WHERE true`, []string{"orders", "regions"}},
		{"an array", postgres, `SELECT a[1], [[1, 2], [3]] FROM orders`, []string{"orders"}},
		{"two statements", postgres, `SELECT * FROM a; SELECT * FROM b`, []string{"a", "b"}},

		{"nothing", postgres, `SELECT 1`, nil},
		{"empty", postgres, ``, nil},
		{"left open", postgres, `SELECT * FROM orders WHERE x = 'abc`, []string{"orders"}},
		{"cut short", postgres, `SELECT * FROM `, nil},
		{"not a statement", postgres, `)) FROM , JOIN ( AS (`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got []string
			for _, table := range Tables(c.sql, c.lexis) {
				got = append(got, table.String())
			}
			if !slices.Equal(got, c.want) {
				t.Errorf("Tables(%s) = %q, want %q", c.sql, got, c.want)
			}
		})
	}
}

func TestTableName(t *testing.T) {
	tables := Tables(`SELECT * FROM lake.sales.orders`, dialect.Lexis{})
	if len(tables) != 1 || tables[0].Name() != "orders" {
		t.Errorf("tables = %v", tables)
	}
}

func TestPlaceholders(t *testing.T) {
	trino := dialect.Trino{}.Lexis()
	sql := `SELECT '?', "why?" -- ?
FROM t /* ? */ WHERE a = ? AND b IN (?, ?) AND c = 'it''s ?'`
	at := strings.Index(sql, "a = ?") + 4
	want := []int{at, at + 12, at + 15}
	if got := Placeholders(sql, trino); !slices.Equal(got, want) {
		t.Errorf("placeholders at %v, want %v", got, want)
	}
	if got := Placeholders(`SELECT 1`, trino); len(got) != 0 {
		t.Errorf("placeholders in a statement with none: %v", got)
	}
}
