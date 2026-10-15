package handlers

import (
	"strings"
	"testing"

	"ooapi/internal/trading"
)

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
	if !strings.Contains(fills.Artifact, "没有成交") || !strings.Contains(risk.Artifact, "deny") {
		t.Fatalf("risk=%q fills=%q", risk.Artifact, fills.Artifact)
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
	if strings.Contains(fills.Artifact, "order paper-") || !strings.Contains(fills.Artifact, "funding_extreme") {
		t.Fatalf("fills %q", fills.Artifact)
	}
}
