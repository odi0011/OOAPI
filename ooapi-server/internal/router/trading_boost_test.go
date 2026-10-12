package router

import (
	"encoding/json"
	"net/http"
	"testing"

	"ooapi/internal/config"
	"ooapi/internal/trading"
)

func TestBoostRoutesUseDedicatedBearer(t *testing.T) {
	t.Setenv(trading.EnvBoostToken, "route-boost-token")
	trading.ResetBoostForTest()
	t.Cleanup(trading.ResetBoostForTest)

	engine := Setup(&config.Config{JWTSecret: "router-boost-test", WebDir: t.TempDir()})
	noToken := hitTrading(engine, http.MethodPost, "/api/trading/engine/boost", ``, "")
	if noToken.Code != http.StatusUnauthorized {
		t.Fatalf("no token %d %s", noToken.Code, noToken.Body.String())
	}
	userJWT := hitTrading(engine, http.MethodPost, "/api/trading/engine/boost", ``, "not-the-boost-token")
	if userJWT.Code != http.StatusUnauthorized {
		t.Fatalf("jwt %d %s", userJWT.Code, userJWT.Body.String())
	}
	granted := hitTrading(engine, http.MethodPost, "/api/trading/engine/boost", ``, "route-boost-token")
	if granted.Code != http.StatusOK {
		t.Fatalf("grant %d %s", granted.Code, granted.Body.String())
	}
	events := hitTrading(engine, http.MethodGet, "/api/trading/engine/events", ``, "route-boost-token")
	if events.Code != http.StatusOK {
		t.Fatalf("events %d %s", events.Code, events.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(events.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["action"] != "boost_start" {
		t.Fatalf("events %#v", rows)
	}
}
