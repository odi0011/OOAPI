package handlers

import (
	"strings"
	"testing"

	"ooapi/internal/trading"
)

func TestVetPromptCarriesChiefProposal(t *testing.T) {
	proposal := chiefProposal("short", "Short")
	prompt := vetPrompt(proposal)
	if !strings.Contains(prompt, "short XRPUSDT") || !strings.Contains(prompt, "Chief reply: Short") || !strings.Contains(prompt, "Pick veto or pass.") {
		t.Fatalf("prompt = %s", prompt)
	}
	if strings.Contains(prompt, "Proposal short.") {
		t.Fatal("old ambiguous prompt")
	}
}

func TestReadableSentences(t *testing.T) {
	if priceSentence(1.3079) != "1.31" {
		t.Fatalf("price %s", priceSentence(1.3079))
	}
	if sideSentence("short") != "提案做空" {
		t.Fatal(sideSentence("short"))
	}
	allow := false
	_, fills := paperRisk(&allow, "short", "Short", "Pass", 1.3079, 0.0001, nil)
	if fills.Summary != "测试盘未成交，因为决策拒绝" {
		t.Fatalf("summary %q", fills.Summary)
	}
}

func TestSideAndVetoWords(t *testing.T) {
	side, err := sideFromWord(" Short ")
	if err != nil || side != "short" {
		t.Fatalf("side %q %v", side, err)
	}
	if _, err := sideFromWord("uncertain"); err == nil {
		t.Fatal("accepted uncertain")
	}
	veto, err := vetoFromWord("pass")
	if err != nil || veto {
		t.Fatalf("veto %v %v", veto, err)
	}
	veto, err = vetoFromWord("veto")
	if err != nil || !veto {
		t.Fatalf("veto word %v %v", veto, err)
	}
}

func TestExtractJSONObject(t *testing.T) {
	raw := extractJSON("```json\n{\"side\":\"long\",\"note\":\"up\"}\n```")
	if string(raw) != `{"side":"long","note":"up"}` {
		t.Fatalf("json = %s", raw)
	}
	if extractJSON("no object") != nil {
		t.Fatal("accepted prose")
	}
}

func TestPaperRiskDenyDoesNotFill(t *testing.T) {
	allow := false
	risk, fills := paperRisk(&allow, "long", "test", "", 1.3, 0.0001, nil)
	if strings.Contains(fills.Artifact, "order paper-") || fills.Error != "" {
		t.Fatalf("fill leaked %+v", fills)
	}
	if !strings.Contains(fills.Summary, "未成交") || !strings.Contains(risk.Artifact, "deny") {
		t.Fatalf("risk=%q fills=%q", risk.Artifact, fills.Summary)
	}
}

func TestPaperRiskAllowRecordsFill(t *testing.T) {
	allow := true
	risk, fills := paperRisk(&allow, string(trading.SideLong), "trend", "", 1.3, 0.0001, nil)
	if fills.Error != "" || !strings.Contains(fills.Artifact, "order paper-1") || !strings.Contains(fills.Artifact, "status filled") {
		t.Fatalf("fills %+v risk %s", fills, risk.Artifact)
	}
	if !strings.Contains(risk.Artifact, "allow") {
		t.Fatalf("risk %s", risk.Artifact)
	}
}

func TestPaperRiskFundingBlocksBeforeFill(t *testing.T) {
	allow := true
	_, fills := paperRisk(&allow, "long", "", "", 1.3, 0.02, nil)
	if strings.Contains(fills.Artifact, "order paper-") || !strings.Contains(fills.Summary, "资金费率") {
		t.Fatalf("fills %q", fills.Summary)
	}
}
