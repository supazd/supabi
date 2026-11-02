package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"strings"
	"testing"

	driver "github.com/go-sql-driver/mysql"

	_ "github.com/supazd/supabi/internal/datasource/mysql"
	"github.com/supazd/supabi/internal/id"
)

// The API does not know which database is behind a data source. This walks
// the same path as the PostgreSQL tests, from connecting to querying, on MySQL.
func TestMySQLDatasourceEndToEnd(t *testing.T) {
	dsn := os.Getenv("SUPABI_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("SUPABI_TEST_MYSQL_DSN is not set")
	}
	cfg, err := driver.ParseDSN(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MultiStatements = true
	connector, _ := driver.NewConnector(cfg)
	db := sql.OpenDB(connector)
	name := id.New("test")
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `
		CREATE DATABASE `+name+` CHARACTER SET utf8mb4;
		CREATE TABLE `+name+`.orders (id int, order_date date, amount decimal(12,2), region varchar(50));
		INSERT INTO `+name+`.orders VALUES (1, '2026-01-10', 100.50, '华东'), (2, '2026-02-10', 200.00, '华东'), (3, '2026-02-20', 300.25, '华南')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(ctx, "DROP DATABASE "+name)
		_ = db.Close()
	})

	c := newClient(t)
	host, port, _ := strings.Cut(cfg.Addr, ":")
	input := map[string]any{
		"name": "mysql", "type": "mysql", "password": cfg.Passwd, "dataTimezone": "Asia/Shanghai",
		"settings": map[string]string{"host": host, "port": port, "database": name, "user": cfg.User, "tls": "false"},
	}
	if r := c.expect("POST", "/datasources/test", input, 200, ""); r["ok"] != true {
		t.Fatalf("connection test = %v", r)
	}
	wrong := map[string]any{"name": "x", "type": "mysql", "password": "not-the-password", "settings": input["settings"]}
	if r := c.expect("POST", "/datasources/test", wrong, 200, ""); r["ok"] != false {
		t.Errorf("connection test with a wrong password = %v", r)
	}
	sourceID := c.expect("POST", "/datasources", input, 201, "")["id"].(string)

	source := map[string]any{"type": "sql", "sql": "SELECT * FROM orders WHERE order_date >= {{since}}"}
	params := []any{map[string]any{"name": "since", "type": "date", "required": true, "default": "2026-01-01"}}
	_, columns := c.do("POST", "/datasources/"+sourceID+"/describe", map[string]any{"source": source, "params": params})
	encoded, _ := json.Marshal(columns)
	if want := `[{"dbType":"int","name":"id","type":"integer"},{"dbType":"date","name":"order_date","type":"date"},{"dbType":"decimal","name":"amount","type":"decimal"},{"dbType":"varchar","name":"region","type":"string"}]`; string(encoded) != want {
		t.Errorf("describe:\n got %s\nwant %s", encoded, want)
	}

	spec := map[string]any{
		"specVersion": 1, "source": source, "params": params,
		"fields": []any{
			map[string]any{"key": "order_date", "label": "下单日期", "column": "order_date", "type": "date", "role": "dimension"},
			map[string]any{"key": "amount", "label": "金额", "column": "amount", "type": "decimal", "role": "dimension"},
			map[string]any{"key": "region", "label": "地区", "column": "region", "type": "string", "role": "dimension"},
			map[string]any{"key": "revenue", "label": "销售额", "column": "amount", "type": "decimal", "role": "measure"},
		},
	}
	broken := map[string]any{}
	raw, _ := json.Marshal(spec)
	_ = json.Unmarshal(raw, &broken)
	broken["fields"].([]any)[1].(map[string]any)["column"] = "amuont"
	c.expect("POST", "/datasets", map[string]any{"name": "d", "datasourceId": sourceID, "spec": broken}, 422, "dataset_sql_error")

	created := c.expect("POST", "/datasets", map[string]any{"name": "订单", "datasourceId": sourceID, "spec": spec}, 201, "")
	if created["validationStatus"] != "valid" {
		t.Fatalf("created = %v", created)
	}
	result := c.expect("POST", "/query", `{"query":{"version":1,"dataset":"`+created["id"].(string)+`","dimensions":[{"field":"order_date","grain":"month","alias":"month"}],"measures":[{"field":"revenue","agg":"sum"}],"filter":{"field":"order_date","op":"time","value":{"last":{"n":1,"unit":"month"}}}}}`, 200, "")
	if rows, _ := json.Marshal(result["rows"]); string(rows) != `[["2026-02-01","500.25"]]` {
		t.Errorf("rows = %s", rows)
	}
}
