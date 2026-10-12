package auth

import "testing"

func TestIssueCarriesSessionVersion(t *testing.T) {
	const secret = "session-version-test"
	token, err := Issue(secret, 42, "ada", 1, 7)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Parse(secret, token)
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != 42 || claims.SessionVersion != 7 {
		t.Fatalf("claims = %+v", claims)
	}
	if !claims.MatchesSession(7) {
		t.Fatal("current version rejected")
	}
	if claims.MatchesSession(6) || claims.MatchesSession(0) {
		t.Fatal("stale version accepted")
	}
}
