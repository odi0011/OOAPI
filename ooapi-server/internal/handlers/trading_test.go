package handlers

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
	"ooapi/internal/trading"
)

const (
	testAPIKey    = "binance-api-key-0123456789"
	testAPISecret = "binance-api-secret-abcdef9876"
)

func TestTradingExchangeKeyEncryptMaskRevealRevoke(t *testing.T) {
	d := useTradingDB(t)
	owner := tradingUser(7)
	other := tradingUser(8)

	rec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"name": "主号",
		"exchange": "binance",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("create status=%d body=%s", rec.Code, rec.Body.String())
	}
	created := tradingData(t, rec)
	assertNoPlainSecret(t, created)
	if created["exchange"] != exchangeBinance || created["network"] != networkTestnet || created["label"] != "主号" {
		t.Fatalf("metadata = %#v", created)
	}
	if !strings.Contains(fmt.Sprint(created["apiKeyMasked"]), "••••") {
		t.Fatalf("key not masked: %#v", created["apiKeyMasked"])
	}
	id := int64(created["id"].(float64))
	stored := d.key(id)
	if stored == nil || !cryptoutil.IsEncrypted(stored.apiKey) || !cryptoutil.IsEncrypted(stored.apiSecret) {
		t.Fatalf("ciphertext missing: %+v", stored)
	}
	if strings.Contains(stored.apiKey, testAPIKey) || strings.Contains(stored.apiSecret, testAPISecret) {
		t.Fatal("plaintext stored in the row")
	}
	opened, err := services.OpenExchangeSecret(stored.apiKey)
	if err != nil || opened != testAPIKey {
		t.Fatalf("open key = %q err=%v", opened, err)
	}

	list := callTrading(t, ListExchangeKeys, http.MethodGet, "/api/trading/exchange-keys", "", owner, "")
	items := tradingItems(t, list)
	if len(items) != 1 || strings.Contains(list.Body.String(), testAPIKey) || strings.Contains(list.Body.String(), "enc:v1:") {
		t.Fatalf("list leaked or missed row: %s", list.Body.String())
	}

	otherList := callTrading(t, ListExchangeKeys, http.MethodGet, "/api/trading/exchange-keys", "", other, "")
	if len(tradingItems(t, otherList)) != 0 {
		t.Fatalf("other user saw keys: %s", otherList.Body.String())
	}

	denied := callTrading(t, RevealExchangeKey, http.MethodPost, "/api/trading/exchange-keys/1/reveal", "", other, fmt.Sprint(id))
	if denied.Code != http.StatusNotFound {
		t.Fatalf("cross-user reveal = %d %s", denied.Code, denied.Body.String())
	}

	revealed := callTrading(t, RevealExchangeKey, http.MethodPost, "/api/trading/exchange-keys/1/reveal", "", owner, fmt.Sprint(id))
	if revealed.Code != http.StatusOK {
		t.Fatalf("reveal = %d %s", revealed.Code, revealed.Body.String())
	}
	body := tradingData(t, revealed)
	if body["apiKey"] != testAPIKey || body["apiSecret"] != testAPISecret {
		t.Fatalf("reveal body = %#v", body)
	}

	revoked := callTrading(t, RevokeExchangeKey, http.MethodPost, "/api/trading/exchange-keys/1/revoke", "", owner, fmt.Sprint(id))
	if revoked.Code != http.StatusOK || tradingData(t, revoked)["revoked"] != true {
		t.Fatalf("revoke = %d %s", revoked.Code, revoked.Body.String())
	}
	again := callTrading(t, RevokeExchangeKey, http.MethodDelete, "/api/trading/exchange-keys/1", "", owner, fmt.Sprint(id))
	if again.Code != http.StatusOK || tradingData(t, again)["revoked"] != true {
		t.Fatalf("second revoke = %d %s", again.Code, again.Body.String())
	}
	if !cryptoutil.IsEncrypted(d.key(id).apiSecret) {
		t.Fatal("revoke deleted ciphertext")
	}

	anon := callTrading(t, ListExchangeKeys, http.MethodGet, "/api/trading/exchange-keys", "", nil, "")
	if anon.Code != http.StatusUnauthorized {
		t.Fatalf("anon = %d", anon.Code)
	}
}

func TestTradingStrategyCRUDValidationAndLiveWarning(t *testing.T) {
	d := useTradingDB(t)
	owner := tradingUser(3)
	other := tradingUser(4)

	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))

	liveKeyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "live-api-key-0123456789",
		"apiSecret": "live-api-secret-abcdef9876"
	}`, owner, "")
	liveKeyID := int64(tradingData(t, liveKeyRec)["id"].(float64))

	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d}`, keyID), owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("create strategy = %d %s", created.Code, created.Body.String())
	}
	view := tradingData(t, created)
	strategyID := int64(view["id"].(float64))
	assertStrategyDefaults(t, view)
	if warnings, _ := view["warnings"].([]any); len(warnings) != 0 {
		t.Fatalf("testnet warnings = %#v", view["warnings"])
	}

	if rec := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "leverage": %d}`, keyID, trading.MaxLeverage+1), owner, ""); rec.Code != http.StatusBadRequest || tradingCode(t, rec) != "invalid_leverage" {
		t.Fatalf("leverage = %d %s", rec.Code, rec.Body.String())
	}
	accepted := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		fmt.Sprintf(`{"leverage": %d, "dailyLossPct": %g}`, trading.MaxLeverage, float64(trading.DailyLossOffPct)), owner, fmt.Sprint(strategyID))
	if accepted.Code != http.StatusOK {
		t.Fatalf("cap save = %d %s", accepted.Code, accepted.Body.String())
	}
	capped := tradingData(t, accepted)
	if capped["leverage"] != float64(trading.MaxLeverage) || capped["dailyLossPct"] != float64(trading.DailyLossOffPct) || capped["marginMode"] != strategyMarginMode {
		t.Fatalf("capped = %#v", capped)
	}
	if rec := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		`{"dailyLossPct": 100.01}`, owner, fmt.Sprint(strategyID)); tradingCode(t, rec) != "invalid_risk" {
		t.Fatalf("daily loss = %s", rec.Body.String())
	}
	if rec := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		`{"marginMode": "cross", "leverage": 20}`, owner, fmt.Sprint(strategyID)); tradingCode(t, rec) != "invalid_margin_mode" {
		t.Fatalf("cross at 20x = %s", rec.Body.String())
	}
	if rec := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "marginMode": "cross"}`, keyID), owner, ""); tradingCode(t, rec) != "invalid_margin_mode" {
		t.Fatalf("margin = %s", rec.Body.String())
	}
	if len(d.strategyIDs()) != 1 {
		t.Fatalf("invalid writes were stored: %v", d.strategyIDs())
	}

	live := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		fmt.Sprintf(`{"mode": "live", "exchangeKeyId": %d, "leverage": 2}`, keyID), owner, fmt.Sprint(strategyID))
	if live.Code != http.StatusOK {
		t.Fatalf("live save = %d %s", live.Code, live.Body.String())
	}
	liveView := tradingData(t, live)
	if liveView["mode"] != networkLive || liveView["leverage"] != float64(2) || liveView["symbol"] != strategySymbol {
		t.Fatalf("patched = %#v", liveView)
	}
	warnText := fmt.Sprint(liveView["warnings"])
	if !strings.Contains(warnText, liveModeWarning) || !strings.Contains(warnText, networkMismatchWarning) {
		t.Fatalf("warnings = %s", warnText)
	}

	matched := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		fmt.Sprintf(`{"exchangeKeyId": %d}`, liveKeyID), owner, fmt.Sprint(strategyID))
	if matched.Code != http.StatusOK || !strings.Contains(fmt.Sprint(tradingData(t, matched)["warnings"]), liveModeWarning) {
		t.Fatalf("matched live = %d %s", matched.Code, matched.Body.String())
	}
	if strings.Contains(fmt.Sprint(tradingData(t, matched)["warnings"]), networkMismatchWarning) {
		t.Fatalf("same-network key should not warn mismatch: %s", matched.Body.String())
	}

	revoked := callTrading(t, RevokeExchangeKey, http.MethodPost, "/revoke", "", owner, fmt.Sprint(liveKeyID))
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke live key = %d %s", revoked.Code, revoked.Body.String())
	}
	blocked := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		`{"stopR": 2}`, owner, fmt.Sprint(strategyID))
	if tradingCode(t, blocked) != "exchange_key_revoked" {
		t.Fatalf("revoked key still selectable: %d %s", blocked.Code, blocked.Body.String())
	}
	got := callTrading(t, GetTradingStrategy, http.MethodGet, "/api/trading/strategies/1", "", owner, fmt.Sprint(strategyID))
	if tradingData(t, got)["exchangeKeyActive"] != false || !strings.Contains(got.Body.String(), revokedKeyWarning) {
		t.Fatalf("revoked strategy view = %s", got.Body.String())
	}
	hidden := callTrading(t, GetTradingStrategy, http.MethodGet, "/api/trading/strategies/1", "", other, fmt.Sprint(strategyID))
	if hidden.Code != http.StatusNotFound {
		t.Fatalf("other user get = %d %s", hidden.Code, hidden.Body.String())
	}

	rebound := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/1",
		fmt.Sprintf(`{"exchangeKeyId": %d, "mode": "testnet", "stopR": 2}`, keyID), owner, fmt.Sprint(strategyID))
	if rebound.Code != http.StatusOK || tradingData(t, rebound)["stopR"] != float64(2) {
		t.Fatalf("rebind = %d %s", rebound.Code, rebound.Body.String())
	}

	listed := tradingItems(t, callTrading(t, ListTradingStrategies, http.MethodGet, "/api/trading/strategies", "", owner, ""))
	if len(listed) != 1 || int64(listed[0].(map[string]any)["id"].(float64)) != strategyID {
		t.Fatalf("list = %#v", listed)
	}

	deleted := callTrading(t, DeleteTradingStrategy, http.MethodDelete, "/api/trading/strategies/1", "", owner, fmt.Sprint(strategyID))
	if deleted.Code != http.StatusOK || tradingData(t, deleted)["deleted"] != true {
		t.Fatalf("delete = %d %s", deleted.Code, deleted.Body.String())
	}
	missing := callTrading(t, GetTradingStrategy, http.MethodGet, "/api/trading/strategies/1", "", owner, fmt.Sprint(strategyID))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("after delete = %d %s", missing.Code, missing.Body.String())
	}
}

func TestTradingEngineUsesNewestStrategyAndHidesSecrets(t *testing.T) {
	useTradingDB(t)
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	owner := tradingUser(11)

	missing := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", `{"equityUsdt":2}`, owner, "")
	if missing.Code != http.StatusNotFound || tradingCode(t, missing) != "not_found" {
		t.Fatalf("missing strategy = %d %s", missing.Code, missing.Body.String())
	}

	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	liveKey := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "live-api-key-0123456789",
		"apiSecret": "live-api-secret-abcdef9876"
	}`, owner, "")
	liveKeyID := int64(tradingData(t, liveKey)["id"].(float64))

	older := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "maxMarginUsdt": 1.6}`, keyID), owner, "")
	olderID := int64(tradingData(t, older)["id"].(float64))
	newer := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d}`, keyID), owner, "")
	newerID := int64(tradingData(t, newer)["id"].(float64))

	started := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", `{
		"equityUsdt": 2,
		"fundingRate": 0.0001,
		"now": "2026-10-12T00:00:00Z"
	}`, owner, "")
	if started.Code != http.StatusOK {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	if strings.Contains(started.Body.String(), testAPISecret) || strings.Contains(started.Body.String(), testAPIKey) || strings.Contains(started.Body.String(), "enc:v1:") {
		t.Fatalf("start leaked secret: %s", started.Body.String())
	}
	view := tradingData(t, started)
	if view["state"] != "Armed" || int64(view["strategyId"].(float64)) != newerID {
		t.Fatalf("start view = %#v want strategy %d", view, newerID)
	}
	assertNoPlainSecret(t, view)

	stepped := callTrading(t, StepTradingEngine, http.MethodPost, "/api/trading/engine/step", `{
		"equityUsdt": 2,
		"markPrice": 0.5,
		"fundingRate": 0.0001,
		"now": "2026-10-12T00:05:00Z"
	}`, owner, "")
	if stepped.Code != http.StatusOK || tradingData(t, stepped)["state"] != "Armed" {
		t.Fatalf("idle step = %d %s", stepped.Code, stepped.Body.String())
	}
	if strings.Contains(stepped.Body.String(), testAPISecret) {
		t.Fatal("step leaked secret")
	}

	state := callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state?strategyId="+fmt.Sprint(olderID), "", owner, "")
	if state.Code != http.StatusOK || tradingData(t, state)["state"] != "Idle" || int64(tradingData(t, state)["strategyId"].(float64)) != olderID {
		t.Fatalf("older state = %d %s", state.Code, state.Body.String())
	}

	live := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "mode": "live"}`, liveKeyID), owner, "")
	if live.Code != http.StatusOK {
		t.Fatalf("live strategy = %d %s", live.Code, live.Body.String())
	}
	refused := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", `{"equityUsdt":2}`, owner, "")
	if refused.Code != http.StatusConflict || tradingCode(t, refused) != "live_gate_closed" {
		t.Fatalf("live start = %d %s", refused.Code, refused.Body.String())
	}
	if strings.Contains(refused.Body.String(), "live-api-secret") {
		t.Fatal("live refusal leaked secret")
	}
}

func TestExchangeSecretOpenerAcceptsMatchingLiveKey(t *testing.T) {
	useTradingDB(t)
	owner := tradingUser(21)
	const apiKey = "live-api-key-0123456789"
	const apiSecret = "live-api-secret-abcdef9876"
	created := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "`+apiKey+`",
		"apiSecret": "`+apiSecret+`"
	}`, owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("create live key = %d %s", created.Code, created.Body.String())
	}
	keyID := int64(tradingData(t, created)["id"].(float64))
	row := strategyRow{Record: strategyRecord{ExchangeKeyID: keyID, Mode: networkLive}}
	creds, err := exchangeSecretOpener(owner.ID, row)()
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != apiKey || creds.APISecret != apiSecret || creds.Network != networkLive {
		t.Fatalf("live creds network=%q key=%q", creds.Network, creds.APIKey)
	}

	row.Record.Mode = networkTestnet
	if _, err := exchangeSecretOpener(owner.ID, row)(); !errors.Is(err, trading.ErrKeyNotUsable) {
		t.Fatalf("live key on testnet strategy err=%v", err)
	}

	testnetKey := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	if testnetKey.Code != http.StatusOK {
		t.Fatalf("create testnet key = %d %s", testnetKey.Code, testnetKey.Body.String())
	}
	testnetID := int64(tradingData(t, testnetKey)["id"].(float64))
	row = strategyRow{Record: strategyRecord{ExchangeKeyID: testnetID, Mode: networkLive}}
	if _, err := exchangeSecretOpener(owner.ID, row)(); !errors.Is(err, trading.ErrKeyNotUsable) {
		t.Fatalf("testnet key on live strategy err=%v", err)
	}
	row.Record.Mode = networkTestnet
	creds, err = exchangeSecretOpener(owner.ID, row)()
	if err != nil {
		t.Fatal(err)
	}
	if creds.APIKey != testAPIKey || creds.APISecret != testAPISecret || creds.Network != networkTestnet {
		t.Fatalf("testnet creds network=%q", creds.Network)
	}
}

func TestRunningXRPRejectsSecondStrategy(t *testing.T) {
	useTradingDB(t)
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	owner := tradingUser(31)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	first := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "entryMode": "trend"}`, keyID), owner, "")
	if first.Code != http.StatusOK || tradingData(t, first)["entryMode"] != "trend" || tradingData(t, first)["symbol"] != "XRPUSDT" {
		t.Fatalf("create = %d %s", first.Code, first.Body.String())
	}
	firstID := int64(tradingData(t, first)["id"].(float64))
	second := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "entryMode": "cross"}`, keyID), owner, "")
	if second.Code != http.StatusOK || tradingData(t, second)["entryMode"] != "cross" {
		t.Fatalf("second = %d %s", second.Code, second.Body.String())
	}
	secondID := int64(tradingData(t, second)["id"].(float64))
	started := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", fmt.Sprintf(`{
		"strategyId": %d,
		"equityUsdt": 20,
		"fundingRate": 0.0001,
		"now": "2026-10-12T00:00:00Z"
	}`, firstID), owner, "")
	if started.Code != http.StatusOK || tradingData(t, started)["running"] != true {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	dupStart := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", fmt.Sprintf(`{
		"strategyId": %d,
		"equityUsdt": 20
	}`, secondID), owner, "")
	if dupStart.Code != http.StatusConflict || tradingCode(t, dupStart) != "symbol_in_use" {
		t.Fatalf("second start = %d %s", dupStart.Code, dupStart.Body.String())
	}
	dup := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d}`, keyID), owner, "")
	if dup.Code != http.StatusConflict || tradingCode(t, dup) != "symbol_in_use" {
		t.Fatalf("dup create = %d %s", dup.Code, dup.Body.String())
	}
	other := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "symbol": "DOGEUSDT"}`, keyID), owner, "")
	if other.Code != http.StatusOK || tradingData(t, other)["symbol"] != "DOGEUSDT" {
		t.Fatalf("doge = %d %s", other.Code, other.Body.String())
	}
	bad := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "symbol": "BTCUSD"}`, keyID), owner, "")
	if bad.Code != http.StatusBadRequest || tradingCode(t, bad) != "invalid_symbol" {
		t.Fatalf("bad symbol = %d %s", bad.Code, bad.Body.String())
	}
}

func TestLiveRejectsWeakWinRateAndSampleSize(t *testing.T) {
	useTradingDB(t)
	owner := tradingUser(41)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	win := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "mode": "live", "minWinRate": 0}`, keyID), owner, "")
	if win.Code != http.StatusBadRequest || tradingCode(t, win) != "minWinRate" {
		t.Fatalf("win rate = %d %s", win.Code, win.Body.String())
	}
	trades := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "mode": "live", "minTrades": 1}`, keyID), owner, "")
	if trades.Code != http.StatusBadRequest || tradingCode(t, trades) != "minTrades" {
		t.Fatalf("trades = %d %s", trades.Code, trades.Body.String())
	}
}

func TestGambleModeStoresOverridesAndReloadsEngine(t *testing.T) {
	useTradingDB(t)
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	owner := tradingUser(44)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "实盘",
		"network": "live",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "mode": "live", "gambleMode": true, "minWinRate": 0, "minTrades": 1, "minScore": 2, "scalpTpPct": 0.001, "scalpSlPct": 0.004}`, keyID), owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	view := tradingData(t, created)
	if view["gambleMode"] != true || view["minWinRate"] != float64(0) || view["minTrades"] != float64(1) || view["minScore"] != float64(2) {
		t.Fatalf("create view %#v", view)
	}
	if view["scalpTpPct"] != 0.001 || view["scalpSlPct"] != 0.004 {
		t.Fatalf("scalp %#v", view)
	}
	id := int64(view["id"].(float64))
	trading.SetTestnetGreen(true)
	t.Cleanup(trading.ResetTestnetGreen)
	started := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start", fmt.Sprintf(`{
		"strategyId": %d,
		"equityUsdt": 20,
		"fundingRate": 0.0001,
		"liqDistancePct": -1
	}`, id), owner, "")
	if started.Code != http.StatusOK || tradingData(t, started)["running"] != true {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	patched := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/"+fmt.Sprint(id),
		`{"minScore": 1, "scalpTpPct": 0.002, "takeProfitR": 1.2, "stopR": 0.8, "timeframe": "15m"}`, owner, fmt.Sprint(id))
	if patched.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", patched.Code, patched.Body.String())
	}
	body := tradingData(t, patched)
	if body["minScore"] != float64(1) || body["timeframe"] != "15m" || body["stopR"] != 0.8 || body["takeProfitR"] != 1.2 || body["gambleMode"] != true {
		t.Fatalf("patch %#v", body)
	}
	cfg, ok := trading.DefaultHub().Config(owner.ID, id)
	if !ok || cfg.MinScore != 1 || !cfg.GambleMode || cfg.Timeframe != "15m" || cfg.StopR != 0.8 || cfg.TakeProfitR != 1.2 || cfg.ScalpTpPct != 0.002 {
		t.Fatalf("reloaded %+v ok=%v", cfg, ok)
	}
	snap, found := trading.DefaultHub().State(owner.ID, id)
	if !found || !snap.Running || snap.State != trading.StateArmed {
		t.Fatalf("still running %+v found=%v", snap, found)
	}
}

func TestDOGEStrategyAcceptsPlannerParams(t *testing.T) {
	useTradingDB(t)
	owner := tradingUser(42)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	body := fmt.Sprintf(`{
		"symbol": "DOGEUSDT",
		"exchangeKeyId": %d,
		"timeframe": "15m",
		"emaFast": 12,
		"emaSlow": 26,
		"takeProfitR": 1,
		"rsiLongMin": 40,
		"rsiLongMax": 80,
		"rsiShortMin": 20,
		"rsiShortMax": 60,
		"minScore": 4,
		"leverage": 20,
		"marginMode": "isolated",
		"entryMode": "trend"
	}`, keyID)
	rec := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies", body, owner, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("create = %d %s", rec.Code, rec.Body.String())
	}
	view := tradingData(t, rec)
	checks := map[string]any{
		"symbol": "DOGEUSDT", "timeframe": "15m", "emaFast": float64(12), "emaSlow": float64(26),
		"takeProfitR": float64(1), "rsiLongMin": float64(40), "rsiLongMax": float64(80),
		"rsiShortMin": float64(20), "rsiShortMax": float64(60), "minScore": float64(4),
		"leverage": float64(20), "marginMode": "isolated", "entryMode": "trend",
	}
	for key, want := range checks {
		if view[key] != want {
			t.Fatalf("%s = %v want %v", key, view[key], want)
		}
	}
}

func assertStrategyDefaults(t *testing.T, view map[string]any) {
	t.Helper()
	checks := []struct {
		key  string
		want any
	}{
		{"symbol", strategySymbol},
		{"leverage", float64(defaultLeverage)},
		{"marginMode", strategyMarginMode},
		{"emaFast", float64(defaultEmaFast)},
		{"emaSlow", float64(defaultEmaSlow)},
		{"timeframe", defaultTimeframe},
		{"stopR", float64(defaultStopR)},
		{"takeProfitR", defaultTakeProfitR},
		{"dailyLossPct", float64(defaultDailyLossPct)},
		{"maxMarginUsdt", defaultMaxMarginUsdt},
		{"mode", networkTestnet},
		{"entryMode", trading.EntryModeTrend},
		{"minScore", float64(trading.DefaultMinScore)},
		{"minWinRate", trading.DefaultMinWinRate},
		{"minTrades", float64(trading.DefaultMinTrades)},
		{"maxMarginPerTradeUsdt", float64(trading.DefaultMaxMarginPerTradeUSDT)},
		{"maxConsecutiveLosses", float64(trading.DefaultMaxConsecutiveLosses)},
		{"pauseBalanceUsdt", float64(trading.DefaultPauseBalanceUSDT)},
		{"pauseEntries", false},
		{"maxOpenPositions", float64(0)},
		{"rsiLongMin", 50.0},
		{"rsiLongMax", 70.0},
		{"rsiShortMin", 30.0},
		{"rsiShortMax", 50.0},
		{"gambleMode", false},
		{"scalpTpPct", trading.DefaultScalpPct},
		{"scalpSlPct", trading.DefaultScalpPct},
	}
	for _, check := range checks {
		got := view[check.key]
		switch want := check.want.(type) {
		case float64:
			gotN, ok := got.(float64)
			if !ok || gotN != want {
				t.Fatalf("%s = %#v want %v", check.key, got, want)
			}
		default:
			if got != want {
				t.Fatalf("%s = %#v want %#v", check.key, got, want)
			}
		}
	}
}

func assertNoPlainSecret(t *testing.T, data map[string]any) {
	t.Helper()
	for _, key := range []string{"apiKey", "apiSecret", "api_key", "api_secret"} {
		if _, ok := data[key]; ok {
			t.Fatalf("plaintext field %s in %#v", key, data)
		}
	}
	raw := fmt.Sprint(data)
	if strings.Contains(raw, testAPIKey) || strings.Contains(raw, testAPISecret) || strings.Contains(raw, "enc:v1:") {
		t.Fatalf("secret material in view: %s", raw)
	}
}

func tradingUser(id int64) *models.User {
	return &models.User{ID: id, Username: fmt.Sprintf("user%d", id), Status: 1, Role: int(authz.RoleUser)}
}

func callTrading(t *testing.T, h gin.HandlerFunc, method, path, body string, user *models.User, id string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	c.Request = httptest.NewRequest(method, path, reader)
	c.Request.Header.Set("Content-Type", "application/json")
	if user != nil {
		c.Set(middleware.CtxUserKey, user)
		c.Set(middleware.CtxRoleKey, authz.ParseRole(user.Role))
	}
	if id != "" {
		c.Params = gin.Params{{Key: "id", Value: id}}
	}
	h(c)
	return rec
}

func tradingData(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v body=%s", err, rec.Body.String())
	}
	data, ok := body["data"].(map[string]any)
	if !ok {
		t.Fatalf("missing data: %s", rec.Body.String())
	}
	return data
}

func tradingItems(t *testing.T, rec *httptest.ResponseRecorder) []any {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", rec.Code, rec.Body.String())
	}
	items, ok := tradingData(t, rec)["items"].([]any)
	if !ok {
		t.Fatalf("items missing: %s", rec.Body.String())
	}
	return items
}

func tradingCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("json: %v body=%s", err, rec.Body.String())
	}
	errObj, _ := body["error"].(map[string]any)
	code, _ := errObj["code"].(string)
	return code
}

type tradingKeyRow struct {
	id        int64
	userID    int64
	label     string
	exchange  string
	network   string
	apiKey    string
	apiSecret string
	status    int
	revokedAt string
	createdAt string
	updatedAt string
}

type tradingStrategyRow struct {
	id        int64
	userID    int64
	rec       strategyRecord
	createdAt string
	updatedAt string
}

type storedEntry struct {
	id  int64
	rec trading.EntryRecord
}

type tradingTestDriver struct {
	mu         sync.Mutex
	seq        int64
	clock      int
	keys       map[int64]*tradingKeyRow
	strategies map[int64]*tradingStrategyRow
	entries    []storedEntry
}

func (d *tradingTestDriver) key(id int64) *tradingKeyRow {
	d.mu.Lock()
	defer d.mu.Unlock()
	row := d.keys[id]
	if row == nil {
		return nil
	}
	copy := *row
	return &copy
}

func (d *tradingTestDriver) strategyIDs() []int64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]int64, 0, len(d.strategies))
	for id := range d.strategies {
		out = append(out, id)
	}
	return out
}

var tradingDriverSeq atomic.Uint64

func useTradingDB(t *testing.T) *tradingTestDriver {
	t.Helper()
	services.SetJWTSecret("trading-test-secret")
	t.Cleanup(func() { services.SetJWTSecret("") })
	d := &tradingTestDriver{
		keys:       map[int64]*tradingKeyRow{},
		strategies: map[int64]*tradingStrategyRow{},
	}
	name := fmt.Sprintf("trading-handler-%d", tradingDriverSeq.Add(1))
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
	return d
}

func (d *tradingTestDriver) Open(string) (driver.Conn, error) {
	return &tradingTestConn{d}, nil
}

type tradingTestConn struct{ d *tradingTestDriver }

func (c *tradingTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *tradingTestConn) Close() error              { return nil }
func (c *tradingTestConn) Begin() (driver.Tx, error) { return nil, fmt.Errorf("unexpected Begin") }

type tradingTestResult struct{ lastID, affected int64 }

func (r tradingTestResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r tradingTestResult) RowsAffected() (int64, error) { return r.affected, nil }

type tradingTestRows struct {
	columns []string
	values  [][]driver.Value
}

func (r *tradingTestRows) Columns() []string { return r.columns }
func (r *tradingTestRows) Close() error      { return nil }
func (r *tradingTestRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

func normTradingSQL(q string) string {
	return strings.Join(strings.Fields(strings.ToUpper(q)), " ")
}

func tradingArgInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	default:
		return 0
	}
}

func tradingArgString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	default:
		return fmt.Sprint(s)
	}
}

func tradingArgTime(v any) time.Time {
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		parsed, err := time.Parse(time.RFC3339, t)
		if err != nil {
			parsed, _ = time.Parse("2006-01-02 15:04:05", t)
		}
		return parsed
	default:
		return time.Time{}
	}
}

func pauseEntriesValue(paused bool) int64 {
	if paused {
		return 1
	}
	return 0
}

func tradingArgFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	case string:
		var out float64
		fmt.Sscanf(n, "%f", &out)
		return out
	default:
		return 0
	}
}

func (d *tradingTestDriver) stampLocked() string {
	d.clock++
	return time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC).Add(time.Duration(d.clock) * time.Second).Format(tradingTimeLayout)
}

func (c *tradingTestConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := namedValues(args)
	switch normTradingSQL(q) {
	case normTradingSQL(exchangeKeyInsertSQL):
		id := d.seq + 1
		d.seq = id
		now := d.stampLocked()
		d.keys[id] = &tradingKeyRow{
			id: id, userID: tradingArgInt(vals[0]), label: tradingArgString(vals[1]),
			exchange: tradingArgString(vals[2]), network: tradingArgString(vals[3]),
			apiKey: tradingArgString(vals[4]), apiSecret: tradingArgString(vals[5]),
			status: int(tradingArgInt(vals[6])), createdAt: now, updatedAt: now,
		}
		return tradingTestResult{id, 1}, nil
	case normTradingSQL(exchangeKeyRevokeSQL):
		id, userID := tradingArgInt(vals[2]), tradingArgInt(vals[3])
		row := d.keys[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		row.status = int(tradingArgInt(vals[0]))
		row.revokedAt = tradingArgString(vals[1])
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyInsertSQL):
		id := d.seq + 1
		d.seq = id
		now := d.stampLocked()
		d.strategies[id] = &tradingStrategyRow{
			id: id, userID: tradingArgInt(vals[0]), createdAt: now, updatedAt: now,
			rec: strategyRecord{
				Symbol: tradingArgString(vals[1]), Leverage: int(tradingArgInt(vals[2])),
				MarginMode: tradingArgString(vals[3]), EmaFast: int(tradingArgInt(vals[4])),
				EmaSlow: int(tradingArgInt(vals[5])), Timeframe: tradingArgString(vals[6]),
				StopR: tradingArgFloat(vals[7]), TakeProfitR: tradingArgFloat(vals[8]),
				DailyLossPct: tradingArgFloat(vals[9]), MaxMarginUsdt: tradingArgFloat(vals[10]),
				ExchangeKeyID: tradingArgInt(vals[11]), Mode: tradingArgString(vals[12]),
				EntryMode: tradingArgString(vals[13]), MinScore: int(tradingArgInt(vals[14])),
				MinWinRate: tradingArgFloat(vals[15]), MinTrades: int(tradingArgInt(vals[16])),
				MaxMarginPerTradeUsdt: tradingArgFloat(vals[17]), MaxConsecutiveLosses: int(tradingArgInt(vals[18])),
				PauseBalanceUsdt: tradingArgFloat(vals[19]), PauseReason: tradingArgString(vals[20]),
				MaxOpenPositions: int(tradingArgInt(vals[21])),
				RSILongMin:       tradingArgFloat(vals[22]), RSILongMax: tradingArgFloat(vals[23]),
				RSIShortMin: tradingArgFloat(vals[24]), RSIShortMax: tradingArgFloat(vals[25]),
				GambleMode: tradingArgInt(vals[26]) == 1,
				ScalpTpPct: tradingArgFloat(vals[27]), ScalpSlPct: tradingArgFloat(vals[28]),
				Running: tradingArgInt(vals[29]) == 1,
			},
		}
		return tradingTestResult{id, 1}, nil
	case normTradingSQL(strategyUpdateSQL):
		id, userID := tradingArgInt(vals[28]), tradingArgInt(vals[29])
		row := d.strategies[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		running := row.rec.Running
		row.rec = strategyRecord{
			Symbol: tradingArgString(vals[0]), Leverage: int(tradingArgInt(vals[1])),
			MarginMode: tradingArgString(vals[2]), EmaFast: int(tradingArgInt(vals[3])),
			EmaSlow: int(tradingArgInt(vals[4])), Timeframe: tradingArgString(vals[5]),
			StopR: tradingArgFloat(vals[6]), TakeProfitR: tradingArgFloat(vals[7]),
			DailyLossPct: tradingArgFloat(vals[8]), MaxMarginUsdt: tradingArgFloat(vals[9]),
			ExchangeKeyID: tradingArgInt(vals[10]), Mode: tradingArgString(vals[11]),
			EntryMode: tradingArgString(vals[12]), MinScore: int(tradingArgInt(vals[13])),
			MinWinRate: tradingArgFloat(vals[14]), MinTrades: int(tradingArgInt(vals[15])),
			MaxMarginPerTradeUsdt: tradingArgFloat(vals[16]), MaxConsecutiveLosses: int(tradingArgInt(vals[17])),
			PauseBalanceUsdt: tradingArgFloat(vals[18]), PauseReason: tradingArgString(vals[19]),
			MaxOpenPositions: int(tradingArgInt(vals[20])),
			RSILongMin:       tradingArgFloat(vals[21]), RSILongMax: tradingArgFloat(vals[22]),
			RSIShortMin: tradingArgFloat(vals[23]), RSIShortMax: tradingArgFloat(vals[24]),
			GambleMode: tradingArgInt(vals[25]) == 1,
			ScalpTpPct: tradingArgFloat(vals[26]), ScalpSlPct: tradingArgFloat(vals[27]),
			Running: running,
		}
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyRunningSQL):
		id, userID := tradingArgInt(vals[1]), tradingArgInt(vals[2])
		row := d.strategies[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		row.rec.Running = tradingArgInt(vals[0]) == 1
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyRunningByIDSQL):
		id := tradingArgInt(vals[1])
		row := d.strategies[id]
		if row == nil {
			return tradingTestResult{0, 0}, nil
		}
		row.rec.Running = tradingArgInt(vals[0]) == 1
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyPauseByIDSQL):
		id := tradingArgInt(vals[1])
		row := d.strategies[id]
		if row == nil {
			return tradingTestResult{0, 0}, nil
		}
		row.rec.Running = false
		row.rec.PauseReason = tradingArgString(vals[0])
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyPauseEntriesSQL):
		id, userID := tradingArgInt(vals[1]), tradingArgInt(vals[2])
		row := d.strategies[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		row.rec.PauseEntries = tradingArgInt(vals[0]) != 0
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyClearPauseSQL):
		id, userID := tradingArgInt(vals[0]), tradingArgInt(vals[1])
		row := d.strategies[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		row.rec.PauseReason = ""
		row.updatedAt = d.stampLocked()
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(strategyDeleteSQL):
		id, userID := tradingArgInt(vals[0]), tradingArgInt(vals[1])
		row := d.strategies[id]
		if row == nil || row.userID != userID {
			return tradingTestResult{0, 0}, nil
		}
		delete(d.strategies, id)
		return tradingTestResult{0, 1}, nil
	case normTradingSQL(entryInsertSQL):
		id := d.seq + 1
		d.seq = id
		opened := tradingArgTime(vals[16])
		rec := trading.EntryRecord{
			ID: id, UserID: tradingArgInt(vals[0]), StrategyID: tradingArgInt(vals[1]),
			Symbol: tradingArgString(vals[2]), Side: tradingArgString(vals[3]),
			OpenedAt: opened, EntryPrice: tradingArgFloat(vals[14]), Qty: tradingArgFloat(vals[15]),
		}
		rec.Score = int(tradingArgInt(vals[4]))
		rec.MinScore = int(tradingArgInt(vals[5]))
		rec.Boost = tradingArgInt(vals[6]) != 0
		rec.Forced = tradingArgInt(vals[7]) != 0
		rec.WinRate = tradingArgFloat(vals[8])
		rec.Trades = int(tradingArgInt(vals[9]))
		rec.NetR = tradingArgFloat(vals[10])
		rec.ExpectancyR = tradingArgFloat(vals[11])
		rec.ExpectancyUSDT = tradingArgFloat(vals[12])
		rec.OneRUSDT = tradingArgFloat(vals[13])
		d.entries = append(d.entries, storedEntry{id: id, rec: rec})
		return tradingTestResult{id, 1}, nil
	case normTradingSQL(entryReviseSQL):
		id := tradingArgInt(vals[2])
		for i := range d.entries {
			rec := &d.entries[i].rec
			if d.entries[i].id != id || !rec.ClosedAt.IsZero() {
				continue
			}
			rec.EntryPrice = tradingArgFloat(vals[0])
			rec.Qty = tradingArgFloat(vals[1])
			return tradingTestResult{0, 1}, nil
		}
		return tradingTestResult{0, 0}, nil
	case normTradingSQL(entryCloseSQL):
		id := tradingArgInt(vals[5])
		userID := tradingArgInt(vals[6])
		strategyID := tradingArgInt(vals[7])
		for i := range d.entries {
			rec := &d.entries[i].rec
			if d.entries[i].id != id || rec.UserID != userID || rec.StrategyID != strategyID || !rec.ClosedAt.IsZero() {
				continue
			}
			rec.ExitPrice = tradingArgFloat(vals[0])
			rec.ExitQty = tradingArgFloat(vals[1])
			rec.RealizedUSDT = tradingArgFloat(vals[2])
			rec.ExitReason = tradingArgString(vals[3])
			rec.ClosedAt = tradingArgTime(vals[4])
			return tradingTestResult{0, 1}, nil
		}
		return tradingTestResult{0, 0}, nil
	default:
		return nil, fmt.Errorf("unexpected exec: %s", normTradingSQL(q))
	}
}

func (c *tradingTestConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := namedValues(args)
	switch normTradingSQL(q) {
	case normTradingSQL(exchangeKeyListSQL):
		return d.keyRows(tradingArgInt(vals[0]), 0), nil
	case normTradingSQL(exchangeKeyByIDSQL):
		return d.keyRows(tradingArgInt(vals[1]), tradingArgInt(vals[0])), nil
	case normTradingSQL(exchangeKeyMetaSQL):
		return d.keyMeta(tradingArgInt(vals[1]), tradingArgInt(vals[0])), nil
	case normTradingSQL(strategyListSQL):
		return d.strategyRows(tradingArgInt(vals[0]), 0), nil
	case normTradingSQL(strategyByIDSQL):
		return d.strategyRows(tradingArgInt(vals[1]), tradingArgInt(vals[0])), nil
	case normTradingSQL(strategyRunningDupSQL):
		return d.runningDup(tradingArgInt(vals[0]), tradingArgInt(vals[1]), tradingArgString(vals[2]), tradingArgInt(vals[3])), nil
	case normTradingSQL(entryListSQL):
		return d.entryRows(tradingArgInt(vals[0]), tradingArgInt(vals[1]), int(tradingArgInt(vals[2]))), nil
	case normTradingSQL(entryOpenSQL):
		return d.entryOpenRows(tradingArgInt(vals[0]), tradingArgInt(vals[1])), nil
	case normTradingSQL(entryRecentSQL):
		return d.entryRows(0, 0, int(tradingArgInt(vals[0]))), nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", normTradingSQL(q))
	}
}

func namedValues(args []driver.NamedValue) []any {
	out := make([]any, len(args))
	for i, arg := range args {
		out[i] = arg.Value
	}
	return out
}

func (d *tradingTestDriver) keyRows(userID, id int64) driver.Rows {
	cols := strings.Split(exchangeKeySelectCols, ",")
	for i := range cols {
		cols[i] = strings.TrimSpace(cols[i])
	}
	var values [][]driver.Value
	ids := make([]int64, 0, len(d.keys))
	for keyID := range d.keys {
		ids = append(ids, keyID)
	}
	sortDesc(ids)
	for _, keyID := range ids {
		row := d.keys[keyID]
		if row.userID != userID || (id != 0 && row.id != id) {
			continue
		}
		var revoked any
		if row.revokedAt != "" {
			revoked = row.revokedAt
		}
		values = append(values, []driver.Value{
			row.id, row.label, row.exchange, row.network, row.apiKey, row.apiSecret,
			int64(row.status), revoked, row.createdAt, row.updatedAt,
		})
	}
	return &tradingTestRows{columns: cols, values: values}
}

func (d *tradingTestDriver) keyMeta(userID, id int64) driver.Rows {
	cols := []string{"id", "network", "status"}
	row := d.keys[id]
	if row == nil || row.userID != userID {
		return &tradingTestRows{columns: cols}
	}
	return &tradingTestRows{columns: cols, values: [][]driver.Value{{row.id, row.network, int64(row.status)}}}
}

func (d *tradingTestDriver) strategyRows(userID, id int64) driver.Rows {
	cols := []string{
		"id", "symbol", "leverage", "margin_mode", "ema_fast", "ema_slow", "timeframe",
		"stop_r", "take_profit_r", "daily_loss_pct", "max_margin_usdt", "exchange_key_id", "mode",
		"entry_mode", "min_score", "min_win_rate", "min_trades",
		"max_margin_per_trade_usdt", "max_consecutive_losses", "pause_balance_usdt", "pause_reason", "pause_entries",
		"max_open_positions",
		"rsi_long_min", "rsi_long_max", "rsi_short_min", "rsi_short_max",
		"gamble_mode", "scalp_tp_pct", "scalp_sl_pct", "running",
		"created_at", "updated_at", "network", "status", "label",
	}
	type pair struct {
		id      int64
		updated string
	}
	order := make([]pair, 0, len(d.strategies))
	for strategyID, row := range d.strategies {
		if row.userID != userID || (id != 0 && row.id != id) {
			continue
		}
		order = append(order, pair{strategyID, row.updatedAt})
	}
	for i := 0; i < len(order); i++ {
		for j := i + 1; j < len(order); j++ {
			if order[j].updated > order[i].updated || (order[j].updated == order[i].updated && order[j].id > order[i].id) {
				order[i], order[j] = order[j], order[i]
			}
		}
	}
	var values [][]driver.Value
	for _, item := range order {
		row := d.strategies[item.id]
		var network, status, label any
		if key := d.keys[row.rec.ExchangeKeyID]; key != nil && key.userID == row.userID {
			network = key.network
			status = int64(key.status)
			label = key.label
		}
		rec := row.rec
		running := int64(0)
		if rec.Running {
			running = 1
		}
		gamble := int64(0)
		if rec.GambleMode {
			gamble = 1
		}
		values = append(values, []driver.Value{
			row.id, rec.Symbol, int64(rec.Leverage), rec.MarginMode, int64(rec.EmaFast), int64(rec.EmaSlow), rec.Timeframe,
			rec.StopR, rec.TakeProfitR, rec.DailyLossPct, rec.MaxMarginUsdt, rec.ExchangeKeyID, rec.Mode,
			rec.EntryMode, int64(rec.MinScore), rec.MinWinRate, int64(rec.MinTrades),
			rec.MaxMarginPerTradeUsdt, int64(rec.MaxConsecutiveLosses), rec.PauseBalanceUsdt, rec.PauseReason, pauseEntriesValue(rec.PauseEntries),
			int64(rec.MaxOpenPositions),
			rec.RSILongMin, rec.RSILongMax, rec.RSIShortMin, rec.RSIShortMax,
			gamble, rec.ScalpTpPct, rec.ScalpSlPct, running,
			row.createdAt, row.updatedAt, network, status, label,
		})
	}
	return &tradingTestRows{columns: cols, values: values}
}

func (d *tradingTestDriver) entryRows(userID, strategyID int64, limit int) driver.Rows {
	cols := []string{
		"id", "user_id", "strategy_id", "symbol", "side", "score", "min_score", "boost", "forced",
		"win_rate", "trade_count", "net_r", "expectancy_r", "expectancy_usdt", "one_r_usdt",
		"entry_price", "qty", "opened_at", "exit_price", "exit_qty", "realized_usdt", "exit_reason", "closed_at",
	}
	rows := append([]storedEntry(nil), d.entries...)
	for i := 0; i < len(rows); i++ {
		for j := i + 1; j < len(rows); j++ {
			if rows[j].rec.OpenedAt.After(rows[i].rec.OpenedAt) || (rows[j].rec.OpenedAt.Equal(rows[i].rec.OpenedAt) && rows[j].id > rows[i].id) {
				rows[i], rows[j] = rows[j], rows[i]
			}
		}
	}
	var values [][]driver.Value
	for _, row := range rows {
		rec := row.rec
		if userID != 0 && (rec.UserID != userID || rec.StrategyID != strategyID) {
			continue
		}
		boost, forced := int64(0), int64(0)
		if rec.Boost {
			boost = 1
		}
		if rec.Forced {
			forced = 1
		}
		var closed any
		if !rec.ClosedAt.IsZero() {
			closed = rec.ClosedAt
		}
		values = append(values, []driver.Value{
			row.id, rec.UserID, rec.StrategyID, rec.Symbol, rec.Side,
			int64(rec.Score), int64(rec.MinScore), boost, forced,
			rec.WinRate, int64(rec.Trades), rec.NetR, rec.ExpectancyR, rec.ExpectancyUSDT, rec.OneRUSDT,
			rec.EntryPrice, rec.Qty, rec.OpenedAt,
			rec.ExitPrice, rec.ExitQty, rec.RealizedUSDT, rec.ExitReason, closed,
		})
		if limit > 0 && len(values) >= limit {
			break
		}
	}
	return &tradingTestRows{columns: cols, values: values}
}

func (d *tradingTestDriver) entryOpenRows(userID, strategyID int64) driver.Rows {
	rows := d.entryRows(userID, strategyID, 0).(*tradingTestRows)
	var open [][]driver.Value
	for _, row := range rows.values {
		if row[len(row)-1] != nil {
			continue
		}
		open = append(open, row)
	}
	for i := 0; i < len(open); i++ {
		for j := i + 1; j < len(open); j++ {
			ai, _ := open[i][17].(time.Time)
			aj, _ := open[j][17].(time.Time)
			if aj.Before(ai) || (aj.Equal(ai) && open[j][0].(int64) < open[i][0].(int64)) {
				open[i], open[j] = open[j], open[i]
			}
		}
	}
	rows.values = open
	return rows
}

func (d *tradingTestDriver) runningDup(userID, keyID int64, symbol string, exceptID int64) driver.Rows {
	cols := []string{"id"}
	var values [][]driver.Value
	for _, row := range d.strategies {
		if row.userID != userID || row.rec.ExchangeKeyID != keyID || row.rec.Symbol != symbol || !row.rec.Running || row.id == exceptID {
			continue
		}
		values = append(values, []driver.Value{row.id})
		break
	}
	return &tradingTestRows{columns: cols, values: values}
}

func sortDesc(ids []int64) {
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			if ids[j] > ids[i] {
				ids[i], ids[j] = ids[j], ids[i]
			}
		}
	}
}

func TestPauseEntriesSwitchDoesNotUseBalanceLine(t *testing.T) {
	useTradingDB(t)
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	owner := tradingUser(11)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "pauseBalanceUsdt": 1.5}`, keyID), owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	view := tradingData(t, created)
	id := int64(view["id"].(float64))
	if view["pauseEntries"] != false || view["pauseBalanceUsdt"] != 1.5 {
		t.Fatalf("defaults %#v", view)
	}
	got := tradingData(t, callTrading(t, GetStrategyPauseEntries, http.MethodGet, "/api/trading/strategies/"+fmt.Sprint(id)+"/pause-entries", "", owner, fmt.Sprint(id)))
	if got["pauseEntries"] != false || got["strategyId"] != float64(id) {
		t.Fatalf("get %#v", got)
	}
	started := callTrading(t, StartTradingEngine, http.MethodPost, "/api/trading/engine/start",
		fmt.Sprintf(`{"strategyId": %d, "equityUsdt": 2}`, id), owner, "")
	if started.Code != http.StatusOK {
		t.Fatalf("start = %d %s", started.Code, started.Body.String())
	}
	posted := tradingData(t, callTrading(t, PostStrategyPauseEntries, http.MethodPost, "/api/trading/strategies/"+fmt.Sprint(id)+"/pause-entries",
		`{"pauseEntries": true}`, owner, fmt.Sprint(id)))
	if posted["pauseEntries"] != true {
		t.Fatalf("post %#v", posted)
	}
	again := tradingData(t, callTrading(t, GetTradingStrategy, http.MethodGet, "/api/trading/strategies/"+fmt.Sprint(id), "", owner, fmt.Sprint(id)))
	if again["pauseEntries"] != true || again["pauseBalanceUsdt"] != 1.5 {
		t.Fatalf("saved %#v", again)
	}
	snap, okSnap := trading.DefaultHub().State(owner.ID, id)
	if !okSnap || !snap.PauseEntries || snap.State != trading.StateArmed {
		t.Fatalf("live snap %+v ok=%v", snap, okSnap)
	}
	cfg, okCfg := trading.DefaultHub().Config(owner.ID, id)
	if !okCfg || !cfg.PauseEntries || cfg.PauseBalanceUsdt != 1.5 {
		t.Fatalf("config %+v ok=%v", cfg, okCfg)
	}
}

func TestPauseBalanceRejectsBelowFloor(t *testing.T) {
	useTradingDB(t)
	owner := tradingUser(12)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "测网",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	for _, raw := range []string{"0", "0.49"} {
		rec := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
			fmt.Sprintf(`{"exchangeKeyId": %d, "pauseBalanceUsdt": %s}`, keyID, raw), owner, "")
		if rec.Code != http.StatusBadRequest || tradingCode(t, rec) != "pauseBalanceUsdt" {
			t.Fatalf("create %s = %d %s", raw, rec.Code, rec.Body.String())
		}
	}
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		fmt.Sprintf(`{"exchangeKeyId": %d, "pauseBalanceUsdt": 0.5}`, keyID), owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("create floor = %d %s", created.Code, created.Body.String())
	}
	id := int64(tradingData(t, created)["id"].(float64))
	updated := callTrading(t, UpdateTradingStrategy, http.MethodPatch, "/api/trading/strategies/"+fmt.Sprint(id),
		`{"pauseBalanceUsdt": 0.4}`, owner, fmt.Sprint(id))
	if updated.Code != http.StatusBadRequest || tradingCode(t, updated) != "pauseBalanceUsdt" {
		t.Fatalf("patch = %d %s", updated.Code, updated.Body.String())
	}
	kept := tradingData(t, callTrading(t, GetTradingStrategy, http.MethodGet, "/api/trading/strategies/"+fmt.Sprint(id), "", owner, fmt.Sprint(id)))
	if kept["pauseBalanceUsdt"] != 0.5 {
		t.Fatalf("kept %#v", kept["pauseBalanceUsdt"])
	}
}
