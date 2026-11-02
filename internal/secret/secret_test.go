package secret

import (
	"bytes"
	"testing"
)

func TestSealAndOpen(t *testing.T) {
	box, err := NewBox(GenerateKey())
	if err != nil {
		t.Fatal(err)
	}
	a, b := box.Seal("p@ss 密码"), box.Seal("p@ss 密码")
	if bytes.Equal(a, b) {
		t.Error("sealing the same value twice gave identical output")
	}
	if bytes.Contains(a, []byte("p@ss")) {
		t.Error("sealed value contains the plaintext")
	}
	if got, err := box.Open(a); err != nil || got != "p@ss 密码" {
		t.Errorf("Open = %q, %v", got, err)
	}

	a[len(a)-1] ^= 1
	if _, err := box.Open(a); err == nil {
		t.Error("a tampered value was accepted")
	}
	other, _ := NewBox(GenerateKey())
	if _, err := other.Open(b); err == nil {
		t.Error("a value was opened with the wrong key")
	}
	if _, err := box.Open([]byte("short")); err == nil {
		t.Error("a truncated value was accepted")
	}
	for _, bad := range []string{"", "not base64!", "c2hvcnQ="} {
		if _, err := NewBox(bad); err == nil {
			t.Errorf("NewBox(%q) should fail", bad)
		}
	}
}
