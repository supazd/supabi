// Package auth holds the primitives of authentication: password hashing,
// session tokens and login throttling. It knows nothing about HTTP or storage.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Argon2id parameters, following the OWASP recommendation of 19 MiB, 2 passes.
// They are stored with each hash, so they can be raised later without
// invalidating existing passwords.
const (
	argonMemoryKiB = 19 * 1024
	argonTime      = 2
	argonThreads   = 1
	argonKeyLen    = 32
	saltLen        = 16
)

const (
	MinPasswordLength = 8
	MaxPasswordLength = 256
)

var ErrPasswordLength = fmt.Errorf("password must be between %d and %d characters", MinPasswordLength, MaxPasswordLength)

// HashPassword returns a self-describing hash in the PHC string format.
func HashPassword(password string) (string, error) {
	if len(password) < MinPasswordLength || len(password) > MaxPasswordLength {
		return "", ErrPasswordLength
	}
	salt := make([]byte, saltLen)
	_, _ = rand.Read(salt) // never fails; see crypto/rand
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemoryKiB, argonThreads, argonKeyLen)
	b64 := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemoryKiB, argonTime, argonThreads, b64.EncodeToString(salt), b64.EncodeToString(key)), nil
}

// VerifyPassword reports whether password matches a hash made by HashPassword.
func VerifyPassword(hash, password string) bool {
	parts := strings.Split(hash, "$")
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	var version int
	var memory, time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil || version != argon2.Version {
		return false
	}
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false
	}
	b64 := base64.RawStdEncoding
	salt, err1 := b64.DecodeString(parts[4])
	want, err2 := b64.DecodeString(parts[5])
	if err1 != nil || err2 != nil || len(want) == 0 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}

// dummyHash lets a login for an unknown account take as long as one for a
// known account, so response time does not reveal which emails exist.
var dummyHash, _ = HashPassword("not a real password")

// VerifyAgainstNothing spends the time of a verification and always fails.
func VerifyAgainstNothing(password string) {
	VerifyPassword(dummyHash, password)
}

// NewSessionToken returns a random token for the browser and the hash to
// store. Only the hash is kept, so a leaked database does not leak sessions.
func NewSessionToken() (token string, hash []byte) {
	raw := make([]byte, 32)
	_, _ = rand.Read(raw)
	token = base64.RawURLEncoding.EncodeToString(raw)
	return token, HashSessionToken(token)
}

func HashSessionToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

var ErrInvalidEmail = errors.New("invalid email address")

// NormalizeEmail trims and lowercases an address and applies a basic sanity check.
func NormalizeEmail(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 || strings.ContainsAny(email, " \t\r\n") || len(email) > 254 {
		return "", ErrInvalidEmail
	}
	return email, nil
}
