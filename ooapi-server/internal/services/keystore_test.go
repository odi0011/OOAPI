package services

import (
	"strings"
	"testing"

	"ooapi/internal/cryptoutil"
)

func TestSealTokenKeyRoundTripAndLookupHash(t *testing.T) {
	SetJWTSecret("keystore-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	plain := "sk-" + strings.Repeat("ab", 24)
	stored, hash, err := SealTokenKey(plain)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !cryptoutil.IsEncrypted(stored) {
		t.Fatalf("stored key is not encrypted: %q", stored)
	}
	if strings.Contains(stored, plain) {
		t.Fatal("ciphertext contains the plaintext key")
	}
	opened, err := OpenTokenKey(stored)
	if err != nil || opened != plain {
		t.Fatalf("open = %q err=%v", opened, err)
	}
	if hash == "" || hash != TokenKeyHash(plain) || hash == TokenKeyHash(plain+"x") {
		t.Fatalf("lookup hash not stable: %q", hash)
	}
}

func TestSealChannelAPIKeyLeavesMarkers(t *testing.T) {
	SetJWTSecret("keystore-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	marker := DeviceCredentialMarker("kiro", 7)
	raw := marker + "\nsk-live-secret-value"
	sealed, err := SealChannelAPIKey(raw)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !strings.Contains(sealed, marker) {
		t.Fatalf("marker was encrypted or dropped: %q", sealed)
	}
	if strings.Contains(sealed, "sk-live-secret-value") {
		t.Fatal("channel secret stored in plaintext")
	}
	opened := OpenChannelAPIKey(sealed)
	if opened != raw {
		t.Fatalf("open = %q want %q", opened, raw)
	}
}

func TestSealExchangeSecretRoundTripAndMask(t *testing.T) {
	SetJWTSecret("keystore-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	plain := "binance-api-key-0123456789"
	stored, err := SealExchangeSecret(plain)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if !cryptoutil.IsEncrypted(stored) || strings.Contains(stored, plain) {
		t.Fatalf("stored = %q", stored)
	}
	again, err := SealExchangeSecret(plain)
	if err != nil || again == stored {
		t.Fatal("nonce should make each seal differ")
	}
	opened, err := OpenExchangeSecret(stored)
	if err != nil || opened != plain {
		t.Fatalf("open = %q err=%v", opened, err)
	}
	masked := MaskExchangeSecret(stored)
	if masked == "" || strings.Contains(masked, plain) || strings.Contains(masked, "enc:v1:") {
		t.Fatalf("mask leaked material: %q", masked)
	}
	if MaskExchangeSecret("enc:v1:not-valid-ciphertext") != "" {
		t.Fatal("failed decrypt must not be shown")
	}
	if _, err := SealExchangeSecret("  "); err == nil {
		t.Fatal("empty secret should fail")
	}
}

func TestOpenTokenKeyKeepsLegacyPlaintext(t *testing.T) {
	SetJWTSecret("keystore-test-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	plain := "sk-" + strings.Repeat("cd", 24)
	opened, err := OpenTokenKey(plain)
	if err != nil || opened != plain {
		t.Fatalf("legacy open = %q err=%v", opened, err)
	}
}
