package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"ooapi/internal/trading"
)

const (
	workbenchSymbol = trading.SymbolXRPUSDT
	chiefModel      = "lfm-2.5-2.6b"
	chiefUpstream   = "liquid/lfm-2.5-2.6b:free"
	vetModel        = "minimax-m2.5"
	vetUpstream     = "minimax/minimax-m2.5"
	decisionModel   = "jev-1.13-free"
)

type workbenchStep struct {
	Role     string `json:"role"`
	Model    string `json:"model,omitempty"`
	Artifact string `json:"artifact,omitempty"`
	Error    string `json:"error,omitempty"`
}

type workbenchChain struct {
	Name  string          `json:"name"`
	Steps []workbenchStep `json:"steps"`
}

type workbenchPage struct {
	Roles  []workbenchStep  `json:"roles"`
	Chains []workbenchChain `json:"chains"`
}

func runWorkbenchChains(ctx context.Context) workbenchPage {
	crawler, scan, mark, funding, scanErr := crawlTestnet(ctx)
	chief := workbenchStep{Role: "CHIEF", Model: chiefModel}
	vet := workbenchStep{Role: "VET", Model: vetModel}
	decision := workbenchStep{Role: "决策", Model: decisionModel}
	var allow *bool
	side := ""
	proposalNote := ""
	vetoNote := ""

	if scanErr != nil {
		chief.Error = "未调用：扫描没有标记价"
		vet.Error = "未调用：扫描没有标记价"
		decision.Error = "未调用：扫描没有标记价"
	} else {
		chiefArtifact, chiefSide, chiefNote, err := askChief(ctx)
		if err != nil {
			chief.Error = err.Error()
			vet.Error = "未调用：没有提案"
			decision.Error = "未调用：没有提案"
		} else {
			chief.Artifact = chiefArtifact
			side = chiefSide
			proposalNote = chiefNote
			vetArtifact, vetoed, reason, err := askVet(ctx, chiefSide)
			if err != nil {
				vet.Error = err.Error()
			} else {
				vet.Artifact = vetArtifact
				vetoNote = reason
				if vetoed {
					vetoNote = "veto: " + reason
				}
			}
			state := scan.Artifact + "\n" + chief.Artifact
			if vet.Error != "" {
				state += "\nVET error: " + vet.Error
			} else {
				state += "\n" + vet.Artifact
			}
			decision = askDecision(ctx, state)
			allow = decisionAllow(decision)
		}
	}

	risk, fills := paperRisk(allow, side, proposalNote, vetoNote, mark, funding, scanErr)
	roles := []workbenchStep{crawler, scan, chief, vet, decision, risk, fills}
	return workbenchPage{
		Roles: roles,
		Chains: []workbenchChain{
			{Name: "Scan → Chief → Vet → 决策", Steps: []workbenchStep{scan, chief, vet, decision}},
			{Name: "决策 → RISK → FILLS", Steps: []workbenchStep{decision, risk, fills}},
		},
	}
}

func crawlTestnet(ctx context.Context) (crawler, scan workbenchStep, mark, funding float64, err error) {
	crawler = workbenchStep{
		Role:     "CRAWLER",
		Artifact: "测试盘 GET /fapi/v1/premiumIndex symbol=" + workbenchSymbol,
	}
	scan = workbenchStep{Role: "SCAN"}
	if ctx.Err() != nil {
		err = ctx.Err()
		crawler.Error = err.Error()
		scan.Error = err.Error()
		return crawler, scan, 0, 0, err
	}
	mark, funding, err = trading.PublicClient(trading.ModeTestnet).MarkQuote(workbenchSymbol)
	if err != nil {
		crawler.Error = err.Error()
		scan.Error = "CRAWLER 没有带回测试盘行情：" + err.Error()
		return crawler, scan, 0, 0, err
	}
	if !(mark > 0) {
		err = fmt.Errorf("测试盘标记价不是正数")
		crawler.Error = err.Error()
		scan.Error = err.Error()
		return crawler, scan, 0, 0, err
	}
	scan.Artifact = fmt.Sprintf("symbol %s\n标记价 %s\n资金费率 %s\n来源 CRAWLER 测试盘 premiumIndex",
		workbenchSymbol, formatNum(mark), formatNum(funding))
	return crawler, scan, mark, funding, nil
}

func askChief(ctx context.Context) (artifact, side, note string, err error) {
	// 这两个免费模型在长提示或 JSON 要求下会回空正文。短的一词答复是它们实际返回过的形状。
	word, err := askWord(ctx, chiefUpstream, "Pick long or short.")
	if err != nil {
		return "", "", "", err
	}
	side, err = sideFromWord(word)
	if err != nil {
		return "", "", "", err
	}
	note = word
	artifact = fmt.Sprintf("symbol %s\nside %s\nreply %s\nmodel %s", workbenchSymbol, side, word, chiefModel)
	return artifact, side, note, nil
}

func askVet(ctx context.Context, side string) (artifact string, veto bool, reason string, err error) {
	word, err := askWord(ctx, vetUpstream, "Proposal "+side+". Pick veto or pass.")
	if err != nil {
		return "", false, "", err
	}
	veto, err = vetoFromWord(word)
	if err != nil {
		return "", false, "", err
	}
	reason = word
	label := "不否决"
	if veto {
		label = "否决"
	}
	artifact = fmt.Sprintf("%s\nreply %s\nmodel %s", label, word, vetModel)
	return artifact, veto, reason, nil
}

func sideFromWord(content string) (string, error) {
	word := strings.ToLower(strings.Trim(strings.TrimSpace(content), ".!"))
	switch word {
	case "long", "short":
		return word, nil
	default:
		return "", fmt.Errorf("提案方向无法使用：%s", truncate(content, 80))
	}
}

func vetoFromWord(content string) (bool, error) {
	word := strings.ToLower(strings.Trim(strings.TrimSpace(content), ".!"))
	switch word {
	case "veto":
		return true, nil
	case "pass":
		return false, nil
	default:
		return false, fmt.Errorf("审核答复无法使用：%s", truncate(content, 80))
	}
}

func askWord(ctx context.Context, model, user string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model": model,
		"messages": []map[string]string{
			{"role": "system", "content": "You answer with one word."},
			{"role": "user", "content": user},
		},
		"max_tokens":  800,
		"temperature": 0,
	})
	raw, err := probeUpstream(ctx, model, body)
	if err != nil {
		return "", err
	}
	if message := upstreamMessage(raw); message != "" {
		return "", fmt.Errorf("%s", message)
	}
	content := chatContent(raw)
	if content == "" {
		return "", fmt.Errorf("模型没有返回正文")
	}
	return content, nil
}

func askDecision(ctx context.Context, state string) workbenchStep {
	step := workbenchStep{Role: "决策", Model: decisionModel}
	body, _ := json.Marshal(map[string]any{
		"model": decisionModel,
		"state": state,
		"questions": map[string]any{
			"allow": map[string]any{
				"type":         "noul",
				"instructions": "Should this paper testnet proposal be allowed to reach the risk check? Veto means it should be denied.",
			},
		},
	})
	raw, err := probeUpstream(ctx, decisionModel, body)
	if err != nil {
		step.Error = err.Error()
		return step
	}
	parsed := interpretDecisionBody(raw)
	if parsed.Error != "" {
		step.Error = parsed.Error
		return step
	}
	label := parsed.Decision
	if parsed.Allow != nil {
		if *parsed.Allow {
			label = "allow"
		} else {
			label = "deny"
		}
	}
	step.Artifact = fmt.Sprintf("%s\n%s\nmodel %s", label, parsed.Detail, decisionModel)
	if parsed.Allow != nil {
		step.Artifact = fmt.Sprintf("%s\nallow %t\n%s\nmodel %s", label, *parsed.Allow, parsed.Detail, decisionModel)
	}
	return step
}

func decisionAllow(step workbenchStep) *bool {
	if step.Error != "" {
		return nil
	}
	for _, line := range strings.Split(step.Artifact, "\n") {
		if strings.HasPrefix(line, "allow ") {
			value := strings.TrimPrefix(line, "allow ")
			allow := value == "true"
			return &allow
		}
	}
	return nil
}

func upstreamMessage(raw []byte) string {
	var body struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil || body.Error == nil {
		return ""
	}
	return strings.TrimSpace(body.Error.Message)
}

func chatContent(raw []byte) string {
	var body struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &body) != nil {
		return ""
	}
	if body.Error != nil && body.Error.Message != "" {
		return ""
	}
	if len(body.Choices) == 0 {
		return ""
	}
	return strings.TrimSpace(body.Choices[0].Message.Content)
}

func extractJSON(content string) []byte {
	text := strings.TrimSpace(content)
	text = strings.TrimPrefix(text, "```json")
	text = strings.TrimPrefix(text, "```")
	text = strings.TrimSuffix(text, "```")
	text = strings.TrimSpace(text)
	start := strings.IndexByte(text, '{')
	end := strings.LastIndexByte(text, '}')
	if start < 0 || end <= start {
		return nil
	}
	raw := []byte(text[start : end+1])
	if !json.Valid(raw) {
		return nil
	}
	return raw
}

func paperRisk(allow *bool, sideName, proposalNote, vetoNote string, mark, funding float64, scanErr error) (risk, fills workbenchStep) {
	risk = workbenchStep{Role: "RISK"}
	fills = workbenchStep{Role: "FILLS"}
	if scanErr != nil {
		risk.Error = "未运行：没有测试盘行情"
		fills.Artifact = "没有成交：没有测试盘行情"
		return risk, fills
	}
	cfg := trading.DefaultConfig()
	lines := []string{
		"测试盘 " + workbenchSymbol + " 逐仓",
		"标记价 " + formatNum(mark),
		"资金费率 " + formatNum(funding),
		fmt.Sprintf("杠杆 %d 保证金 %s", cfg.Leverage, formatNum(cfg.MaxMarginUsdt)),
	}
	if blocked, reason := trading.StartBlocked(funding, -1); blocked {
		lines = append(lines, "拦截 "+reason)
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：" + reason
		return risk, fills
	}
	lines = append(lines, "资金费率未拦截")
	side := trading.Side(sideName)
	if side != trading.SideLong && side != trading.SideShort {
		lines = append(lines, "没有方向，不能做风控")
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：没有提案方向"
		return risk, fills
	}
	lines = append(lines, "方向 "+sideName)
	if proposalNote != "" {
		lines = append(lines, "提案 "+proposalNote)
	}
	if vetoNote != "" {
		lines = append(lines, "审核 "+vetoNote)
	}
	_, notional, qty, err := trading.SizePosition(cfg.MaxMarginUsdt, cfg.Leverage, mark, trading.MinNotionalUSDT)
	if err != nil {
		lines = append(lines, "拦截 "+err.Error())
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：" + err.Error()
		return risk, fills
	}
	stop, take, err := trading.ProtectionPrices(side, mark, mark*cfg.RFraction, cfg.StopR, cfg.TakeProfitR)
	if err != nil {
		lines = append(lines, "拦截 "+err.Error())
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：" + err.Error()
		return risk, fills
	}
	liq, err := trading.IsolatedLiqPrice(side, mark, cfg.Leverage, trading.DefaultMaintMarginRate)
	if err != nil {
		lines = append(lines, "拦截 "+err.Error())
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：" + err.Error()
		return risk, fills
	}
	lines = append(lines,
		"数量 "+formatNum(qty),
		"名义 "+formatNum(notional),
		"止损 "+formatNum(stop),
		"止盈 "+formatNum(take),
		"强平 "+formatNum(liq),
	)
	if !trading.StopWithinLiquidation(side, mark, stop, liq) {
		lines = append(lines, "拦截 "+trading.ReasonStopBeyondLiquidation)
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：" + trading.ReasonStopBeyondLiquidation
		return risk, fills
	}
	lines = append(lines, "止损在强平价之前")
	if allow == nil {
		lines = append(lines, "拦截：没有决策")
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：没有决策"
		return risk, fills
	}
	if !*allow {
		lines = append(lines, "决策 deny，拦截，未发单")
		risk.Artifact = strings.Join(lines, "\n")
		fills.Artifact = "没有成交：决策拒绝"
		return risk, fills
	}
	fill, err := trading.NewPaper().PlaceEntry(trading.EntryOrder{
		Symbol:     workbenchSymbol,
		Side:       side,
		Qty:        qty,
		Price:      mark,
		Leverage:   cfg.Leverage,
		MarginMode: trading.MarginIsolated,
	})
	if err != nil {
		lines = append(lines, "测网撮合拒绝")
		risk.Artifact = strings.Join(lines, "\n")
		fills.Error = err.Error()
		return risk, fills
	}
	lines = append(lines, "决策 allow，测试盘撮合放行")
	risk.Artifact = strings.Join(lines, "\n")
	fills.Artifact = fmt.Sprintf("order %s\nstatus %s\nside %s\nqty %s\nprice %s",
		fill.OrderID, fill.Status, fill.Side, formatNum(fill.Qty), formatNum(fill.Price))
	return risk, fills
}

func formatNum(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
