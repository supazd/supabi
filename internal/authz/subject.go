package authz

import "slices"

// Subject is who a grant or a rule is for: one user, one group, or every
// member of the workspace. Exactly one of its fields is set.
type Subject struct {
	UserID   string `json:"user,omitempty"`
	GroupID  string `json:"group,omitempty"`
	Everyone bool   `json:"everyone,omitempty"`
}

// Valid reports whether exactly one of s's fields is set.
func (s Subject) Valid() bool {
	n := 0
	for _, set := range []bool{s.UserID != "", s.GroupID != "", s.Everyone} {
		if set {
			n++
		}
	}
	return n == 1
}

// Identity is who is asking, as grants and rules see them: a user and the
// groups they are in.
type Identity struct {
	UserID     string
	GroupIDs   []string
	Attributes map[string][]string
}

// Covers reports whether s is for id: it names them, one of their groups,
// or every member.
func (id Identity) Covers(s Subject) bool {
	return s.Everyone || (s.UserID != "" && s.UserID == id.UserID) || (s.GroupID != "" && slices.Contains(id.GroupIDs, s.GroupID))
}

// CoversAny reports whether any of subjects is for id.
func (id Identity) CoversAny(subjects []Subject) bool {
	return slices.ContainsFunc(subjects, id.Covers)
}
