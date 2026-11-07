package auth

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashing(t *testing.T) {
	ctx := context.Background()
	verify := func(hash, password string) bool {
		t.Helper()
		ok, err := VerifyPassword(ctx, hash, password)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	hash, err := HashPassword(ctx, "correct horse 电池")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$m=19456,t=2,p=1$") || strings.Contains(hash, "correct") {
		t.Errorf("unexpected hash format: %s", hash)
	}
	if !verify(hash, "correct horse 电池") {
		t.Error("the right password was rejected")
	}
	for _, wrong := range []string{"correct horse", "", "Correct horse 电池"} {
		if verify(hash, wrong) {
			t.Errorf("%q was accepted", wrong)
		}
	}
	other, _ := HashPassword(ctx, "correct horse 电池")
	if other == hash {
		t.Error("two hashes of the same password are identical; the salt is not random")
	}
	for _, malformed := range []string{"", "plaintext", "$argon2id$v=19$m=1,t=1,p=1$$", "$bcrypt$x$y$z$w", strings.Replace(hash, "v=19", "v=16", 1)} {
		if verify(malformed, "correct horse 电池") {
			t.Errorf("malformed hash %q verified", malformed)
		}
	}
	if _, err := HashPassword(ctx, "short"); err != ErrPasswordLength {
		t.Errorf("short password: err = %v", err)
	}
	if _, err := HashPassword(ctx, strings.Repeat("x", MaxPasswordLength+1)); err != ErrPasswordLength {
		t.Errorf("long password: err = %v", err)
	}
}

// A hash or check waits while argonAtOnce others run, and gives up waiting
// when its request ends.
func TestPasswordHashingTakesTurns(t *testing.T) {
	ctx := context.Background()
	hash, err := HashPassword(ctx, "correct horse 电池")
	if err != nil {
		t.Fatal(err)
	}
	for range argonAtOnce {
		argonTurns <- struct{}{} // as if that many were running
	}
	waiting, left := make(chan bool, 1), make(chan error, 1)
	go func() {
		ok, _ := VerifyPassword(ctx, hash, "correct horse 电池")
		waiting <- ok
	}()
	ended, cancel := context.WithCancel(ctx)
	go func() {
		_, err := HashPassword(ended, "another password")
		left <- err
	}()
	time.Sleep(50 * time.Millisecond)
	select {
	case <-waiting:
		t.Fatal("checked while every turn was taken")
	case err := <-left:
		t.Fatalf("hashed while every turn was taken: %v", err)
	default:
	}
	cancel()
	if err := <-left; !errors.Is(err, context.Canceled) {
		t.Errorf("gave up with %v, want context.Canceled", err)
	}
	<-argonTurns // one finishes
	if ok := <-waiting; !ok {
		t.Error("the right password was rejected after waiting")
	}
	for range argonAtOnce - 1 {
		<-argonTurns
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
