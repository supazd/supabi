// Package role describes the process roles a single supabi binary can run.
package role

import (
	"fmt"
	"slices"
	"strings"
)

type Role string

const (
	API       Role = "api"
	Worker    Role = "worker"
	Scheduler Role = "scheduler"
)

// All is every role, in start order.
var All = []Role{API, Worker, Scheduler}

// Parse reads a comma-separated role list such as "api,worker". An empty
// string means all roles. The result is deduplicated and in start order.
func Parse(s string) ([]Role, error) {
	if strings.TrimSpace(s) == "" {
		return slices.Clone(All), nil
	}
	seen := map[Role]bool{}
	for _, part := range strings.Split(s, ",") {
		r := Role(strings.TrimSpace(part))
		if !slices.Contains(All, r) {
			return nil, fmt.Errorf("unknown role %q (valid: api, worker, scheduler)", string(r))
		}
		seen[r] = true
	}
	var roles []Role
	for _, r := range All {
		if seen[r] {
			roles = append(roles, r)
		}
	}
	return roles, nil
}
