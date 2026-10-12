package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/trading"
)

func TestBoostHandlerAuthAndRateLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)
	trading.ResetBoostForTest()
	t.Cleanup(trading.ResetBoostForTest)
	r := gin.New()
	r.POST("/api/trading/engine/boost", PostTradingEngineBoost)
	r.GET("/api/trading/engine/events", GetTradingEngineEvents)

	unauthorized := hitBoost(r, http.MethodPost, "/api/trading/engine/boost", "anything")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unset token %d %s", unauthorized.Code, unauthorized.Body.String())
	}

	t.Setenv(trading.EnvBoostToken, "boost-secret")
	missing := hitBoost(r, http.MethodPost, "/api/trading/engine/boost", "")
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing %d %s", missing.Code, missing.Body.String())
	}
	wrong := hitBoost(r, http.MethodPost, "/api/trading/engine/boost", "nope")
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong %d %s", wrong.Code, wrong.Body.String())
	}

	first := hitBoost(r, http.MethodPost, "/api/trading/engine/boost", "boost-secret")
	if first.Code != http.StatusOK {
		t.Fatalf("grant %d %s", first.Code, first.Body.String())
	}
	body := decodeBoost(t, first)
	if body["ok"] != true {
		t.Fatalf("body %#v", body)
	}
	until, err := time.Parse(time.RFC3339, body["until"].(string))
	if err != nil || time.Until(until) < time.Minute || time.Until(until) > trading.BoostWindow+time.Second {
		t.Fatalf("until %v err=%v", body["until"], err)
	}

	second := hitBoost(r, http.MethodPost, "/api/trading/engine/boost", "boost-secret")
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("rate %d %s", second.Code, second.Body.String())
	}
	limited := decodeBoost(t, second)
	if limited["ok"] != false || limited["until"] != body["until"] {
		t.Fatalf("limited %#v", limited)
	}

	trading.AddEvent(trading.DetectionEvent{
		TS: time.Date(2026, 10, 12, 1, 2, 3, 0, time.UTC), Symbol: "XRPUSDT", Side: "long",
		Score: 4, WinRate: 0.62, Action: "skip", Msg: "boost_wait",
	})
	deniedEvents := hitBoost(r, http.MethodGet, "/api/trading/engine/events", "")
	if deniedEvents.Code != http.StatusUnauthorized {
		t.Fatalf("events auth %d", deniedEvents.Code)
	}
	events := hitBoost(r, http.MethodGet, "/api/trading/engine/events", "boost-secret")
	if events.Code != http.StatusOK {
		t.Fatalf("events %d %s", events.Code, events.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(events.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	var started, skip map[string]any
	for _, row := range rows {
		switch row["action"] {
		case "boost_start":
			started = row
		case "skip":
			skip = row
		}
	}
	if started == nil || started["msg"] == "" {
		t.Fatalf("missing boost_start %#v", rows)
	}
	if skip == nil || skip["symbol"] != "XRPUSDT" || skip["side"] != "long" || skip["msg"] != "boost_wait" {
		t.Fatalf("rows %#v", rows)
	}
	if skip["score"] != float64(4) || skip["winrate"] != 0.62 {
		t.Fatalf("score row %#v", skip)
	}
}

func hitBoost(engine http.Handler, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	return rec
}

func decodeBoost(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v body=%s", err, rec.Body.String())
	}
	return body
}
