// Package id generates identifiers for metadata rows.
package id

import (
	"crypto/rand"
	"encoding/base32"
)

// Crockford's alphabet, lowercased: no i, l, o or u, so IDs survive being read aloud or retyped.
var encoding = base32.NewEncoding("0123456789abcdefghjkmnpqrstvwxyz").WithPadding(base32.NoPadding)

// New returns a random ID such as "ds_3f8k2m9q0x7c1b5n4d6h". The prefix names
// the resource type so an ID is self-describing in logs, URLs and specs.
func New(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:]) // never fails; see crypto/rand
	return prefix + "_" + encoding.EncodeToString(b[:])
}
