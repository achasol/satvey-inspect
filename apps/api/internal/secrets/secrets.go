// Package secrets provides purpose-bound authenticated encryption for server-side secrets.
package secrets

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
)

func aead(key string) (cipher.AEAD, error) {
	raw, err := base64.StdEncoding.DecodeString(key)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("configure a base64 32-byte encryption key")
	}
	b, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

func Encrypt(key, purpose, plain string) (string, error) {
	a, err := aead(key)
	if err != nil {
		return "", err
	}
	n := make([]byte, a.NonceSize())
	if _, err = rand.Read(n); err != nil {
		return "", err
	}
	return "v1:" + base64.StdEncoding.EncodeToString(a.Seal(n, n, []byte(plain), []byte(purpose))), nil
}

func Decrypt(key, purpose, encrypted string) (string, error) {
	a, err := aead(key)
	if err != nil {
		return "", err
	}
	if len(encrypted) < 3 || encrypted[:3] != "v1:" {
		return "", errors.New("invalid encrypted secret version")
	}
	b, err := base64.StdEncoding.DecodeString(encrypted[3:])
	if err != nil || len(b) < a.NonceSize() {
		return "", errors.New("invalid encrypted secret")
	}
	plain, err := a.Open(nil, b[:a.NonceSize()], b[a.NonceSize():], []byte(purpose))
	if err != nil {
		return "", errors.New("secret authentication failed")
	}
	return string(plain), nil
}
