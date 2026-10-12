package config

import "testing"

func TestCORSAllowLocalhostDefaults(t *testing.T) {
	if !corsAllowLocalhost("", "") {
		t.Fatal("empty config should allow localhost for dev")
	}
	if corsAllowLocalhost("https://app.example.com", "") {
		t.Fatal("explicit allowlist should not also allow localhost")
	}
	if !corsAllowLocalhost("https://app.example.com", "true") {
		t.Fatal("explicit true should allow localhost")
	}
	if corsAllowLocalhost("", "false") {
		t.Fatal("explicit false should deny localhost")
	}
}
