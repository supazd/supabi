// Package authz defines the roles a member holds in a workspace. See
// .agents/design/access-control.md §4.1.
package authz

import "slices"

// Role is what a member may do in a workspace. A role can do everything the
// roles below it can. Stored values are these strings, so a role must never
// be renamed once released.
type Role string

const (
	// Viewer looks at dashboards and charts, and uses their filters.
	Viewer Role = "viewer"
	// Developer connects data sources, writes SQL, and makes datasets,
	// charts and dashboards.
	Developer Role = "developer"
	// Admin also manages the workspace's members and settings.
	Admin Role = "admin"
)

// Roles lists every role, from least to most able.
var Roles = []Role{Viewer, Developer, Admin}

// Valid reports whether r is a known role.
func (r Role) Valid() bool { return slices.Contains(Roles, r) }

// AtLeast reports whether r can do what min can. No role, the empty string,
// is below every role.
func (r Role) AtLeast(min Role) bool {
	return r.Valid() && slices.Index(Roles, r) >= slices.Index(Roles, min)
}

// Highest returns the most able of roles, or the empty string when none is valid.
func Highest(roles []Role) Role {
	var best Role
	for _, r := range roles {
		if r.Valid() && !best.AtLeast(r) {
			best = r
		}
	}
	return best
}
