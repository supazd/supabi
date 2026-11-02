package qcache

import (
	"container/list"
	"context"
	"sync"
	"time"
)

// Memory keeps entries in this process, up to a total estimated size, and
// drops the least recently used first.
type Memory struct {
	max int64
	now func() time.Time

	mu    sync.Mutex
	used  int64
	order *list.List // most recently used first
	items map[string]*list.Element
}

type memoryItem struct {
	key     string
	entry   *Entry
	size    int64
	expires time.Time
}

func NewMemory(maxBytes int64) *Memory {
	return &Memory{max: maxBytes, now: time.Now, order: list.New(), items: map[string]*list.Element{}}
}

func (m *Memory) Get(_ context.Context, key string) (*Entry, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	el, ok := m.items[key]
	if !ok {
		return nil, nil
	}
	item := el.Value.(*memoryItem)
	if !m.now().Before(item.expires) {
		m.remove(el)
		return nil, nil
	}
	m.order.MoveToFront(el)
	return item.entry, nil
}

func (m *Memory) Set(_ context.Context, key string, e *Entry, ttl time.Duration) error {
	size := int64(e.Bytes())
	m.mu.Lock()
	defer m.mu.Unlock()
	if el, ok := m.items[key]; ok {
		m.remove(el)
	}
	if size > m.max {
		return nil
	}
	m.items[key] = m.order.PushFront(&memoryItem{key: key, entry: e, size: size, expires: m.now().Add(ttl)})
	m.used += size
	for m.used > m.max {
		m.remove(m.order.Back())
	}
	return nil
}

func (m *Memory) remove(el *list.Element) {
	item := m.order.Remove(el).(*memoryItem)
	delete(m.items, item.key)
	m.used -= item.size
}
