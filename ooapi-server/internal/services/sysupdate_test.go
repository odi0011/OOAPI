package services

import "testing"

func TestParseGitHubRepo(t *testing.T) {
	cases := []struct {
		raw   string
		web   string
		owner string
		name  string
		ok    bool
	}{
		{"https://github.com/odi0011/OOAPI", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"https://github.com/odi0011/OOAPI.git", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"git@github.com:odi0011/OOAPI.git", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"https://x-access-token:secret@github.com/odi0011/OOAPI", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"ssh://git@github.com/odi0011/OOAPI.git", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"https://github.com/odi0011/OOAPI/tree/main", "https://github.com/odi0011/OOAPI", "odi0011", "OOAPI", true},
		{"https://gitlab.com/odi0011/OOAPI", "", "", "", false},
		{"", "", "", "", false},
		{"https://github.com/not a repo", "", "", "", false},
	}
	for _, tc := range cases {
		web, owner, name, ok := ParseGitHubRepo(tc.raw)
		if web != tc.web || owner != tc.owner || name != tc.name || ok != tc.ok {
			t.Fatalf("ParseGitHubRepo(%q) = %s %s %s %v", tc.raw, web, owner, name, ok)
		}
		if ok && (containsToken(web) || containsToken(owner) || containsToken(name)) {
			t.Fatalf("token leaked from %q", tc.raw)
		}
	}
}

func containsToken(value string) bool {
	return len(value) > 0 && (value == "secret" || value == "x-access-token:secret")
}

func TestClassifyUpdate(t *testing.T) {
	if got := classifyUpdate("abc", "abc", 0, 0, true); got != "current" {
		t.Fatalf("identical = %s", got)
	}
	if got := classifyUpdate("abc", "def", 3, 0, true); got != "behind" {
		t.Fatalf("behind = %s", got)
	}
	if got := classifyUpdate("abc", "def", 2, 1, true); got != "diverged" {
		t.Fatalf("diverged = %s", got)
	}
	if got := classifyUpdate("abc", "def", 0, 1, true); got != "ahead" {
		t.Fatalf("ahead = %s", got)
	}
	if got := classifyUpdate("", "def", 0, 0, false); got != "unknown" {
		t.Fatalf("unknown = %s", got)
	}
	if got := classifyUpdate("abc", "def", 0, 0, false); got != "behind" {
		t.Fatalf("uncompared difference = %s", got)
	}
}

func TestSafeBranch(t *testing.T) {
	if safeBranch("HEAD") != "main" || safeBranch("-rf") != "main" || safeBranch("release/1") != "release/1" {
		t.Fatal("branch guard failed")
	}
}
