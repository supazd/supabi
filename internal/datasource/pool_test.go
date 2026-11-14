package datasource

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"slices"
	"sync"
	"testing"
)

// noConnector opens connections to nothing, for a pool to count.
type noConnector struct{}

func (noConnector) Connect(context.Context) (driver.Conn, error) { return noConn{}, nil }
func (noConnector) Driver() driver.Driver                        { return nil }

type noConn struct{}

func (noConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("not supported") }
func (noConn) Close() error                        { return nil }
func (noConn) Begin() (driver.Tx, error)           { return nil, errors.New("not supported") }

func TestSizePoolKeepsEveryConnectionOfABurst(t *testing.T) {
	db := sql.OpenDB(noConnector{})
	defer db.Close()
	const size = 12
	SizePool(db, Config{MaxConns: size})
	if got := db.Stats().MaxOpenConnections; got != size {
		t.Fatalf("the pool opens up to %d connections, want %d", got, size)
	}
	// The charts of a dashboard take every connection at once, then give
	// them all back.
	held := make([]*sql.Conn, size)
	for i := range held {
		conn, err := db.Conn(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		held[i] = conn
	}
	for _, conn := range held {
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
	}
	if got := db.Stats().Idle; got != size {
		t.Errorf("%d of %d connections were kept for the next load", got, size)
	}
}

// Zero would leave a database/sql pool without any bound.
func TestPoolHasOneConnectionUnlessSized(t *testing.T) {
	db := sql.OpenDB(noConnector{})
	defer db.Close()
	SizePool(db, Config{})
	if got := db.Stats().MaxOpenConnections; got != 1 {
		t.Errorf("the pool opens up to %d connections, want 1", got)
	}
}

// recordingDriver opens connections that do nothing and keeps the config each
// was opened with.
type recordingDriver struct {
	Driver
	mu      sync.Mutex
	configs []Config
}

func (*recordingDriver) Name() string { return "recording" }

func (d *recordingDriver) Open(_ context.Context, cfg Config) (Conn, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.configs = append(d.configs, cfg)
	return closableConn{}, nil
}

type closableConn struct{ Conn }

func (closableConn) Close() {}

var recording = &recordingDriver{}

// A driver can be registered once, and a test may run more than once.
var registerRecording = sync.OnceFunc(func() { Register(recording) })

func TestManagerSizesThePoolFromTheLimit(t *testing.T) {
	registerRecording()
	recording.mu.Lock()
	recording.configs = nil
	recording.mu.Unlock()

	m := NewManager()
	defer m.Close()
	// The same limit twice opens one pool; another limit reopens it.
	for _, limit := range []int{12, 12, 64, 0} {
		if _, err := m.Get(context.Background(), "src_1", "v1", "recording", limit, func() (Config, error) { return Config{}, nil }); err != nil {
			t.Fatal(err)
		}
	}
	recording.mu.Lock()
	defer recording.mu.Unlock()
	var sizes []int
	for _, cfg := range recording.configs {
		sizes = append(sizes, cfg.MaxConns)
	}
	if want := []int{12 + SpareConns, 64 + SpareConns, 1 + SpareConns}; !slices.Equal(sizes, want) {
		t.Errorf("pools were opened with %v connections, want %v", sizes, want)
	}
}
