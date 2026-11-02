package datasource

import (
	"context"
	"sync"
)

// Manager keeps one open connection pool per data source, so queries do not
// reconnect each time, and limits how many statements run on each at once.
// It is safe for concurrent use.
type Manager struct {
	mu    sync.Mutex
	conns map[string]managed
}

type managed struct {
	conn Conn
	// version changes whenever the data source's settings do.
	version string
	limit   int
}

func NewManager() *Manager {
	return &Manager{conns: map[string]managed{}}
}

// Get returns the connection for a data source, opening it on first use and
// reopening it when version or limit differ from those it was opened with. At
// most limit statements run on it at once. config is only called when a
// connection has to be opened.
func (m *Manager) Get(ctx context.Context, id, version, driver string, limit int, config func() (Config, error)) (Conn, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.conns[id]; ok {
		if existing.version == version && existing.limit == limit {
			return existing.conn, nil
		}
		m.closeLater(existing.conn)
		delete(m.conns, id)
	}
	cfg, err := config()
	if err != nil {
		return nil, err
	}
	conn, err := Open(ctx, driver, cfg)
	if err != nil {
		return nil, err
	}
	conn = Limit(conn, limit)
	m.conns[id] = managed{conn: conn, version: version, limit: limit}
	return conn, nil
}

// Evict closes and forgets the connection of a data source, if any.
func (m *Manager) Evict(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.conns[id]; ok {
		m.closeLater(existing.conn)
		delete(m.conns, id)
	}
}

// Close closes every connection.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, existing := range m.conns {
		existing.conn.Close()
		delete(m.conns, id)
	}
}

// Closing waits for running statements to finish, so it must not hold the lock.
func (m *Manager) closeLater(conn Conn) {
	go conn.Close()
}
