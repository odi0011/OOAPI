package services

import "testing"

func TestAllowAuthAttemptLimitsIPAndIdentity(t *testing.T) {
	ResetAuthAttempts()
	t.Cleanup(ResetAuthAttempts)

	for i := 0; i < authIdentLimit; i++ {
		if err := AllowAuthAttempt("198.51.100.8", "alice@example.com"); err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if err := AllowAuthAttempt("198.51.100.9", "alice@example.com"); err != ErrAuthRateLimited {
		t.Fatalf("identity limit: %v", err)
	}
	// 换一个身份，同一 IP 仍应放行（IP 上限更高）。
	if err := AllowAuthAttempt("198.51.100.8", "bob@example.com"); err != nil {
		t.Fatalf("other identity: %v", err)
	}

	ResetAuthAttempts()
	for i := 0; i < authIPLimit; i++ {
		if err := AllowAuthAttempt("198.51.100.10", ""); err != nil {
			t.Fatalf("ip attempt %d: %v", i, err)
		}
	}
	if err := AllowAuthAttempt("198.51.100.10", "carol"); err != ErrAuthRateLimited {
		t.Fatalf("ip limit: %v", err)
	}
}
