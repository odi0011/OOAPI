package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ooapi/internal/db"
)

type clineCredentialDB struct {
	mu                   sync.Mutex
	encrypted            string
	version              int64
	vendor, method, base string
	writes               int
}

var clineTestDB *clineCredentialDB
var registerClineDB sync.Once

type clineDBDriver struct{}

func (clineDBDriver) Open(string) (driver.Conn, error) { return clineDBConn{}, nil }

type clineDBConn struct{}

func (clineDBConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("prepare not used") }
func (clineDBConn) Close() error                        { return nil }
func (clineDBConn) Begin() (driver.Tx, error)           { return nil, errors.New("transaction not used") }
func (clineDBConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if !strings.HasPrefix(query, "SELECT vendor, method, base_url") {
		return nil, errors.New("unexpected query")
	}
	clineTestDB.mu.Lock()
	defer clineTestDB.mu.Unlock()
	return &clineDBRows{values: []driver.Value{clineTestDB.vendor, clineTestDB.method, clineTestDB.base, clineTestDB.encrypted, clineTestDB.version}}, nil
}
func (clineDBConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if !strings.Contains(query, "auth_version = auth_version + 1") {
		return nil, errors.New("unexpected update")
	}
	clineTestDB.mu.Lock()
	defer clineTestDB.mu.Unlock()
	if args[3].Value.(int64) != clineTestDB.version {
		return driver.RowsAffected(0), nil
	}
	clineTestDB.encrypted = args[0].Value.(string)
	clineTestDB.version++
	clineTestDB.writes++
	return driver.RowsAffected(1), nil
}

type clineDBRows struct {
	values []driver.Value
	done   bool
}

func (*clineDBRows) Columns() []string {
	return []string{"vendor", "method", "base_url", "auth_credential", "auth_version"}
}
func (*clineDBRows) Close() error { return nil }
func (r *clineDBRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	copy(dest, r.values)
	r.done = true
	return nil
}
func setupClineDB(t *testing.T, cred ClineCredential) {
	t.Helper()
	registerClineDB.Do(func() { sql.Register("cline-auth-test", clineDBDriver{}) })
	stored, err := EncryptClineCredential(cred)
	if err != nil {
		t.Fatal(err)
	}
	clineTestDB = &clineCredentialDB{encrypted: stored, version: 1, vendor: "cline", method: "cli", base: ClineAPIBase}
	conn, err := sql.Open("cline-auth-test", "")
	if err != nil {
		t.Fatal(err)
	}
	old := db.DB
	db.DB = conn
	t.Cleanup(func() { db.DB = old; conn.Close(); clineTestDB = nil })
}
func TestClineResolverRefreshesEncryptedOAuthExactlyOnce(t *testing.T) {
	var calls atomic.Int32
	mockCline(t, func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != clineRefreshURL {
			t.Fatal("wrong refresh endpoint")
		}
		calls.Add(1)
		return clineResponse(200, `{"access_token":"fresh-access","refresh_token":"rotated-refresh","expires_in":3600}`), nil
	})
	setupClineDB(t, ClineCredential{AccessToken: "expired-access", RefreshToken: "old-refresh", ExpiresAt: time.Now().Unix() - 1})
	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := ResolveClineToken(context.Background(), 23)
			if err != nil || token != "fresh-access" {
				t.Errorf("resolve %s %v", token, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || clineTestDB.writes != 1 {
		t.Fatal("duplicate refresh", calls.Load(), clineTestDB.writes)
	}
	cred, err := decryptClineCredential(clineTestDB.encrypted)
	if err != nil || cred.RefreshToken != "rotated-refresh" || strings.Contains(clineTestDB.encrypted, "fresh-access") {
		t.Fatal("refresh persisted incorrectly")
	}
}
func TestClineResolverRebindCASDoesNotOverwriteNewAccount(t *testing.T) {
	mockCline(t, func(*http.Request) (*http.Response, error) {
		stored, _ := EncryptClineCredential(ClineCredential{AccessToken: "rebound-account", RefreshToken: "rebound-refresh", ExpiresAt: time.Now().Unix() + 3600})
		clineTestDB.mu.Lock()
		clineTestDB.encrypted = stored
		clineTestDB.version++
		clineTestDB.mu.Unlock()
		return clineResponse(200, `{"access_token":"stale-refreshed-account","expires_in":3600}`), nil
	})
	setupClineDB(t, ClineCredential{AccessToken: "old-account", RefreshToken: "old-refresh", ExpiresAt: time.Now().Unix() - 1})
	token, err := ResolveClineToken(context.Background(), 24)
	if err != nil || token != "rebound-account" || clineTestDB.writes != 0 {
		t.Fatalf("CAS failed: %s %v writes=%d", token, err, clineTestDB.writes)
	}
}
func TestClineResolverRejectsAPIKeyOrNonOfficialEndpoint(t *testing.T) {
	mockCline(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid channel called refresh")
		return nil, nil
	})
	setupClineDB(t, ClineCredential{AccessToken: "access", ExpiresAt: time.Now().Unix() + 3600})
	clineTestDB.method = "api"
	if _, err := ResolveClineToken(context.Background(), 25); err == nil {
		t.Fatal("API key channel treated as OAuth")
	}
	clineTestDB.method = "cli"
	clineTestDB.base = "https://other.example/v1"
	if _, err := ResolveClineToken(context.Background(), 25); err == nil {
		t.Fatal("OAuth token sent to other host")
	}
}
