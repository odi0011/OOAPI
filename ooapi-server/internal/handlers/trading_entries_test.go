package handlers

import (
	"encoding/json"
	"math"
	"net/http"
	"testing"
	"time"

	"ooapi/internal/trading"
)

func TestEntryRecordSurvivesInStateOrdersAndEvents(t *testing.T) {
	useTradingDB(t)
	trading.ResetForTest()
	t.Cleanup(trading.ResetForTest)
	trading.SetEntryLog(dbEntryLog{})
	t.Cleanup(func() { trading.SetEntryLog(nil) })

	owner := tradingUser(11)
	keyRec := callTrading(t, CreateExchangeKey, http.MethodPost, "/api/trading/exchange-keys", `{
		"label": "主号",
		"network": "testnet",
		"apiKey": "`+testAPIKey+`",
		"apiSecret": "`+testAPISecret+`"
	}`, owner, "")
	if keyRec.Code != http.StatusOK {
		t.Fatalf("key %d %s", keyRec.Code, keyRec.Body.String())
	}
	keyID := int64(tradingData(t, keyRec)["id"].(float64))
	created := callTrading(t, CreateTradingStrategy, http.MethodPost, "/api/trading/strategies",
		`{"exchangeKeyId": `+formatID(keyID)+`}`, owner, "")
	if created.Code != http.StatusOK {
		t.Fatalf("strategy %d %s", created.Code, created.Body.String())
	}
	strategyID := int64(tradingData(t, created)["id"].(float64))
	opened := time.Date(2026, 10, 12, 3, 4, 5, 0, time.UTC)
	rec := trading.EntryRecord{
		UserID: owner.ID, StrategyID: strategyID, Symbol: "XRPUSDT", Side: "long",
		EntryPrice: 0.5, Qty: 10, OpenedAt: opened,
		EntryStamp: trading.EntryStamp{
			Score: 4, MinScore: 3, Boost: true, Forced: false,
			WinRate: 0.6, Trades: 10, NetR: 5, ExpectancyR: 0.5,
			OneRUSDT: 0.04, ExpectancyUSDT: 0.02,
		},
	}
	if err := trading.SaveEntry(rec); err != nil {
		t.Fatal(err)
	}
	trading.ResetBoostForTest()

	path := "?strategyId=" + formatID(strategyID)
	state := tradingData(t, callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", owner, ""))
	entries, _ := state["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("state entries %#v", state["entries"])
	}
	row := entries[0].(map[string]any)
	if row["score"] != float64(4) || row["minScore"] != float64(3) || row["boost"] != true || row["forced"] != false {
		t.Fatalf("stamp %#v", row)
	}
	if row["winRate"] != 0.6 || row["trades"] != float64(10) || row["netR"] != float64(5) || row["expectancyR"] != 0.5 || row["expectancyUsdt"] != 0.02 {
		t.Fatalf("stats %#v", row)
	}
	if _, ok := row["userId"]; ok {
		t.Fatalf("user id leaked %#v", row)
	}

	book := &fakeDeskBook{}
	book.install(t)
	orders := tradingData(t, callTrading(t, GetTradingOrders, http.MethodGet, "/api/trading/engine/orders"+path, "", owner, ""))
	listed, _ := orders["entries"].([]any)
	if len(listed) != 1 || listed[0].(map[string]any)["minScore"] != float64(3) {
		t.Fatalf("orders entries %#v", orders["entries"])
	}

	other := tradingUser(12)
	denied := callTrading(t, GetTradingEngineState, http.MethodGet, "/api/trading/engine/state"+path, "", other, "")
	if denied.Code != http.StatusNotFound || jsonContainsEntry(denied.Body.String()) {
		t.Fatalf("cross user %d %s", denied.Code, denied.Body.String())
	}

	events := trading.EventsWithEntries()
	if len(events) != 1 || events[0].Entry == nil || !events[0].Entry.Boost || events[0].Entry.Forced || events[0].Action != "boost_entry" {
		t.Fatalf("restarted events %+v", events)
	}
	if math.Abs(events[0].Entry.ExpectancyUSDT-0.02) > 1e-9 {
		t.Fatalf("event expectancy %+v", events[0].Entry)
	}
}

func jsonContainsEntry(body string) bool {
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		return true
	}
	data, _ := payload["data"].(map[string]any)
	entries, _ := data["entries"].([]any)
	return len(entries) > 0
}
