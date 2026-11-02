// Package secret encrypts the credentials stored in the metadata database.
package secret

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
)

// KeySize is the size of the master key in bytes (AES-256).
const KeySize = 32

// Box seals and opens secrets with AES-256-GCM. A sealed value is the random
// nonce followed by the ciphertext, so the same input never seals the same way twice.
type Box struct {
	aead cipher.AEAD
}

// NewBox reads a base64-encoded key as produced by GenerateKey.
func NewBox(encodedKey string) (*Box, error) {
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != KeySize {
		return nil, fmt.Errorf("secret key must be %d bytes, base64-encoded; create one with `supabi generate-key`", KeySize)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// GenerateKey returns a new random key in the form NewBox accepts.
func GenerateKey() string {
	key := make([]byte, KeySize)
	_, _ = rand.Read(key) // never fails; see crypto/rand
	return base64.StdEncoding.EncodeToString(key)
}

func (b *Box) Seal(plaintext string) []byte {
	nonce := make([]byte, b.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return b.aead.Seal(nonce, nonce, []byte(plaintext), nil)
}

// Open fails when the value was sealed with another key or has been altered.
func (b *Box) Open(sealed []byte) (string, error) {
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return "", errors.New("sealed value is too short")
	}
	plaintext, err := b.aead.Open(nil, sealed[:n], sealed[n:], nil)
	if err != nil {
		return "", errors.New("cannot decrypt: wrong secret key or corrupted value")
	}
	return string(plaintext), nil
}
