package datasource

import (
	"database/sql"
	"time"
)

// The pool of a data source is sized from its concurrency limit, so that a
// statement holding a slot never waits for a connection as well: that wait
// would be neither timed nor reported. See .agents/design/query-ir.md §6.9.

// SpareConns is how many connections a pool holds beyond the statements that
// may run at once. Ping is not limited and takes one of them, so a connection
// test is answered while every slot is taken.
const SpareConns = 2

// ConnMaxIdleTime is how long a connection is kept without use. Until then
// every connection is kept, with no cap on how many: the charts of a
// dashboard are queried together, and a cap would close most of their
// connections after each load only to open them again for the next.
const ConnMaxIdleTime = 5 * time.Minute

// connMaxLifetime replaces a connection however busy it is, so that none
// outlives what a server or a proxy in between allows.
const connMaxLifetime = 30 * time.Minute

// PoolSize is how many connections a driver's pool may open at once.
func (c Config) PoolSize() int { return max(c.MaxConns, 1) }

// SizePool applies the rules above to the pool of a driver built on
// database/sql.
func SizePool(db *sql.DB, cfg Config) {
	n := cfg.PoolSize()
	db.SetMaxOpenConns(n)
	db.SetMaxIdleConns(n)
	db.SetConnMaxIdleTime(ConnMaxIdleTime)
	db.SetConnMaxLifetime(connMaxLifetime)
}
