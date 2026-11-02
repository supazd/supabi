package auth

import (
	"bytes"
	"strings"
	"testing"
)

func TestPasswordHashing(t *testing.T) {
	hash, err := HashPassword("correct horse 电池")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") || strings.Contains(hash, "correct") {
		t.Errorf("unexpected hash format: %s", hash)
	}
	if !VerifyPassword(hash, "correct horse 电池") {
		t.Error("the right password was rejected")
	}
	for _, wrong := range []string{"correct horse", "", "Correct horse 电池"} {
		if VerifyPassword(hash, wrong) {
			t.Errorf("%q was accepted", wrong)
		}
	}
	other, _ := HashPassword("correct horse 电池")
	if other == hash {
		t.Error("two hashes of the same password are identical; the salt is not random")
	}
	for _, malformed := range []string{"", "plaintext", "$argon2id$v=19$m=1,t=1,p=1$$", "$bcrypt$x$y$z$w", strings.Replace(hash, "v=19", "v=16", 1)} {
		if VerifyPassword(malformed, "correct horse 电池") {
			t.Errorf("malformed hash %q verified", malformed)
		}
	}
	if _, err := HashPassword("short"); err != ErrPasswordLength {
		t.Errorf("short password: err = %v", err)
	}
	if _, err := HashPassword(strings.Repeat("x", MaxPasswordLength+1)); err != ErrPasswordLength {
		t.Errorf("long password: err = %v", err)
	}
}

func TestSessionToken(t *testing.T) {
	token, hash := NewSessionToken()
	other, _ := NewSessionToken()
	if token == other || len(token) < 40 {
		t.Errorf("tokens are not random enough: %q %q", token, other)
	}
	if !bytes.Equal(hash, HashSessionToken(token)) || bytes.Contains(hash, []byte(token)) {
		t.Error("the stored hash does not correspond to the token")
	}
}

func TestNormalizeEmail(t *testing.T) {
	if got, err := NormalizeEmail("  Ada@Example.COM "); err != nil || got != "ada@example.com" {
		t.Errorf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "ada", "@example.com", "ada@", "a b@example.com"} {
		if _, err := NormalizeEmail(bad); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
}
