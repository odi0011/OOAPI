package router

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"ooapi/internal/auth"
	"ooapi/internal/config"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

func TestTradingRoutesRequireAuthAndStrategyPermission(t *testing.T) {
	services.SetUploadRoot(t.TempDir())
	t.Cleanup(func() { services.SetUploadRoot("") })

	users := &tradingAuthDriver{users: map[int64]tradingAuthUser{
		1: {id: 1, username: "root", role: 1000},
		2: {id: 2, username: "alice", role: 1},
	}}
	useTradingAuthDB(t, users)

	secret := "router-trading-test"
	engine := Setup(&config.Config{JWTSecret: secret, WebDir: t.TempDir()})
	rootToken := mustIssue(t, secret, 1, "root", 1000)
	userToken := mustIssue(t, secret, 2, "alice", 1)

	protected := []struct{ method, path string }{
		{http.MethodGet, "/api/trading/exchange-keys"},
		{http.MethodPost, "/api/trading/exchange-keys"},
		{http.MethodPost, "/api/trading/exchange-keys/1/reveal"},
		{http.MethodPost, "/api/trading/exchange-keys/1/revoke"},
		{http.MethodDelete, "/api/trading/exchange-keys/1"},
		{http.MethodGet, "/api/trading/strategies"},
		{http.MethodPost, "/api/trading/strategies"},
		{http.MethodPatch, "/api/trading/strategies/1"},
		{http.MethodDelete, "/api/trading/strategies/1"},
		{http.MethodGet, "/api/trading/engine/state"},
		{http.MethodGet, "/api/trading/engine/market"},
		{http.MethodGet, "/api/trading/engine/position"},
		{http.MethodGet, "/api/trading/engine/orders"},
		{http.MethodPost, "/api/trading/engine/start"},
		{http.MethodPost, "/api/trading/engine/stop"},
		{http.MethodPost, "/api/trading/engine/step"},
		{http.MethodPost, "/api/trading/engine/testnet-green"},
	}
	for _, endpoint := range protected {
		t.Run(endpoint.method+" "+endpoint.path, func(t *testing.T) {
			rec := hitTrading(engine, endpoint.method, endpoint.path, `{}`, "")
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("unauthenticated = %d %s", rec.Code, rec.Body.String())
			}
		})
	}

	keyRec := hitTrading(engine, http.MethodPost, "/api/trading/exchange-keys", `{}`, userToken)
	if keyRec.Code != http.StatusBadRequest {
		t.Fatalf("logged-in key create = %d %s", keyRec.Code, keyRec.Body.String())
	}

	denied := hitTrading(engine, http.MethodPost, "/api/trading/strategies", `{}`, userToken)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("user strategy create = %d %s", denied.Code, denied.Body.String())
	}
	deniedEngine := hitTrading(engine, http.MethodPost, "/api/trading/engine/start", `{}`, userToken)
	if deniedEngine.Code != http.StatusForbidden {
		t.Fatalf("user engine start = %d %s", deniedEngine.Code, deniedEngine.Body.String())
	}
	deniedDesk := hitTrading(engine, http.MethodGet, "/api/trading/engine/market", ``, userToken)
	if deniedDesk.Code != http.StatusForbidden {
		t.Fatalf("user desk market = %d %s", deniedDesk.Code, deniedDesk.Body.String())
	}

	allowed := hitTrading(engine, http.MethodPost, "/api/trading/strategies", `{}`, rootToken)
	if allowed.Code != http.StatusBadRequest || tradingErrorCode(t, allowed) != "exchange_key_required" {
		t.Fatalf("root strategy create = %d %s", allowed.Code, allowed.Body.String())
	}
}

func mustIssue(t *testing.T, secret string, id int64, username string, role int) string {
	t.Helper()
	token, err := auth.Issue(secret, id, username, role, 0)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func hitTrading(engine http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func tradingErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v body=%s", err, rec.Body.String())
	}
	errObj, _ := body["error"].(map[string]any)
	code, _ := errObj["code"].(string)
	return code
}

type tradingAuthUser struct {
	id       int64
	username string
	role     int
}

type tradingAuthDriver struct {
	users map[int64]tradingAuthUser
}

type tradingAuthConn struct{ d *tradingAuthDriver }

type tradingAuthRows struct {
	columns []string
	values  [][]driver.Value
}

type tradingAuthResult struct{}

func (tradingAuthResult) LastInsertId() (int64, error) { return 0, nil }
func (tradingAuthResult) RowsAffected() (int64, error) { return 0, nil }

func (d *tradingAuthDriver) Open(string) (driver.Conn, error) { return &tradingAuthConn{d}, nil }
func (c *tradingAuthConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *tradingAuthConn) Close() error              { return nil }
func (c *tradingAuthConn) Begin() (driver.Tx, error) { return nil, fmt.Errorf("unexpected Begin") }

func (r *tradingAuthRows) Columns() []string { return r.columns }
func (r *tradingAuthRows) Close() error      { return nil }
func (r *tradingAuthRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

func (c *tradingAuthConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	if !strings.Contains(strings.ToLower(q), "from users") {
		return nil, fmt.Errorf("unexpected query: %s", q)
	}
	var id int64
	if len(args) > 0 {
		id, _ = args[0].Value.(int64)
	}
	cols := []string{
		"id", "username", "display_name", "password_hash", "email", "role", "status",
		"quota", "used_quota", "group_name", "created_at", "updated_at", "last_login_at",
		"avatar_url", "session_version",
	}
	user, ok := c.d.users[id]
	if !ok {
		return &tradingAuthRows{columns: cols}, nil
	}
	now := time.Now()
	return &tradingAuthRows{columns: cols, values: [][]driver.Value{{
		user.id, user.username, user.username, "", "", int64(user.role), int64(1),
		int64(0), int64(0), "default", now, now, nil, "", int64(0),
	}}}, nil
}

func (c *tradingAuthConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	return nil, fmt.Errorf("unexpected exec")
}

var tradingAuthSeq atomic.Uint64

func useTradingAuthDB(t *testing.T, d *tradingAuthDriver) {
	t.Helper()
	name := fmt.Sprintf("trading-auth-%d", tradingAuthSeq.Add(1))
	sql.Register(name, d)
	conn, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	original := db.DB
	db.DB = conn
	t.Cleanup(func() {
		db.DB = original
		conn.Close()
	})
}
