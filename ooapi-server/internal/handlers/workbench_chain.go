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
	Summary  string `json:"summary,omitempty"`
	Artifact string `json:"artifact,omitempty"`
	Error    string `json:"error,omitempty"`
}

type workbenchEvent struct {
	Role     string `json:"role,omitempty"`
	Status   string `json:"status"`
	Summary  string `json:"summary,omitempty"`
	Artifact string `json:"artifact,omitempty"`
	Model    string `json:"model,omitempty"`
}

func runWorkbenchStream(ctx context.Context, emit func(workbenchEvent)) {
	running := func(role, model string) {
		if ctx.Err() != nil {
			return
		}
		emit(workbenchEvent{Role: role, Status: "running", Model: model})
	}
	finish := func(step workbenchStep) {
		if step.Error != "" {
			if step.Artifact == "" {
				step.Artifact = step.Error
			}
			if step.Summary == "" {
				step.Summary = shortChinese(step.Error)
			}
			emit(workbenchEvent{Role: step.Role, Status: "error", Summary: step.Summary, Artifact: step.Artifact, Model: step.Model})
			return
		}
		emit(workbenchEvent{Role: step.Role, Status: "done", Summary: step.Summary, Artifact: step.Artifact, Model: step.Model})
	}

	running("CRAWLER", "")
	crawler, scan, mark, funding, scanErr := crawlTestnet(ctx)
	finish(crawler)
	if scanErr != nil {
		if scan.Summary == "" {
			scan.Summary = "测试盘行情没拿到"
		}
		finish(scan)
		return
	}
	running("SCAN", "")
	finish(scan)

	running("CHIEF", chiefModel)
	chiefArtifact, side, reply, err := askChief(ctx)
	chief := workbenchStep{Role: "CHIEF", Model: chiefModel, Artifact: chiefArtifact}
	if err != nil {
		chief.Error = err.Error()
		finish(chief)
		return
	}
	chief.Summary = sideSentence(side)
	finish(chief)

	proposal := chiefProposal(side, reply)
	running("VET", vetModel)
	vetArtifact, vetoed, vetReply, err := askVet(ctx, proposal)
	vet := workbenchStep{Role: "VET", Model: vetModel, Artifact: vetArtifact}
	if err != nil {
		vet.Error = err.Error()
		vet.Artifact = proposal + "\n" + err.Error()
		finish(vet)
	} else {
		if vetoed {
			vet.Summary = "否决"
		} else {
			vet.Summary = "不否决"
		}
		finish(vet)
	}

	state := proposal
	if vet.Error != "" {
		state += "\nVet did not answer: " + vet.Error
	} else {
		state += "\n" + vet.Artifact
	}
	running("决策", decisionModel)
	decision := askDecision(ctx, state)
	if decision.Error == "" {
		if decisionAllow(decision) != nil && *decisionAllow(decision) {
			decision.Summary = "决策允许"
		} else if decisionAllow(decision) != nil {
			decision.Summary = "决策拒绝"
		} else {
			decision.Summary = "决策没有给出允许或拒绝"
			decision.Error = decision.Summary
		}
	}
	finish(decision)

	running("RISK", "")
	risk, fills := paperRisk(decisionAllow(decision), side, reply, vetReply, mark, funding, nil)
	finish(risk)
	running("FILLS", "")
	finish(fills)
}

func crawlTestnet(ctx context.Context) (crawler, scan workbenchStep, mark, funding float64, err error) {
	crawler = workbenchStep{Role: "CRAWLER"}
	scan = workbenchStep{Role: "SCAN"}
	if ctx.Err() != nil {
		err = ctx.Err()
		crawler.Error = err.Error()
		crawler.Summary = "这一步超时"
		scan.Error = err.Error()
		scan.Summary = "测试盘行情没拿到"
		return crawler, scan, 0, 0, err
	}
	mark, funding, err = trading.PublicClient(trading.ModeTestnet).MarkQuote(workbenchSymbol)
	if err != nil {
		crawler.Error = err.Error()
		crawler.Summary = "测试盘行情没拿到"
		scan.Error = err.Error()
		scan.Summary = "测试盘行情没拿到"
		return crawler, scan, 0, 0, err
	}
	if !(mark > 0) {
		err = fmt.Errorf("测试盘标记价不是正数")
		crawler.Error = err.Error()
		crawler.Summary = "测试盘行情没拿到"
		scan.Error = err.Error()
		scan.Summary = "测试盘行情没拿到"
		return crawler, scan, 0, 0, err
	}
	crawler.Summary = "拿到测试盘行情"
	crawler.Artifact = fmt.Sprintf("symbol %s\nmark %s\nfunding %s", workbenchSymbol, formatNum(mark), formatNum(funding))
	scan.Summary = fmt.Sprintf("选中 %s，标记价 %s", workbenchSymbol, priceSentence(mark))
	scan.Artifact = crawler.Artifact
	return crawler, scan, mark, funding, nil
}

func chiefProposal(side, reply string) string {
	action := "short"
	if side == "long" {
		action = "long"
	}
	return fmt.Sprintf("Chief proposal: %s %s. Chief reply: %s.", action, workbenchSymbol, strings.TrimSpace(reply))
}

func vetPrompt(proposal string) string {
	return strings.TrimSpace(proposal) + " Pick veto or pass."
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
	artifact = chiefProposal(side, word) + "\nmodel " + chiefModel
	return artifact, side, note, nil
}

func askVet(ctx context.Context, proposal string) (artifact string, veto bool, reason string, err error) {
	word, err := askWord(ctx, vetUpstream, vetPrompt(proposal))
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
	artifact = proposal + "\n" + label + "\nreply " + word + "\nmodel " + vetModel
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
		risk.Error = "没有测试盘行情"
		risk.Summary = "测试盘行情没拿到"
		fills.Summary = "测试盘未成交，因为没有行情"
		fills.Artifact = fills.Summary
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
		risk.Summary = "测试盘拦截，因为" + riskReason(reason)
		fills.Summary = "测试盘未成交，因为" + riskReason(reason)
		fills.Artifact = fills.Summary
		return risk, fills
	}
	lines = append(lines, "资金费率未拦截")
	side := trading.Side(sideName)
	if side != trading.SideLong && side != trading.SideShort {
		lines = append(lines, "没有方向，不能做风控")
		risk.Artifact = strings.Join(lines, "\n")
		risk.Summary = "测试盘没有方向"
		fills.Summary = "测试盘未成交，因为没有提案方向"
		fills.Artifact = fills.Summary
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
		risk.Summary = "测试盘拦截，因为名义价值不够"
		fills.Summary = "测试盘未成交，因为名义价值不够"
		fills.Artifact = fills.Summary + "\n" + err.Error()
		return risk, fills
	}
	stop, take, err := trading.ProtectionPrices(side, mark, mark*cfg.RFraction, cfg.StopR, cfg.TakeProfitR)
	if err != nil {
		lines = append(lines, "拦截 "+err.Error())
		risk.Artifact = strings.Join(lines, "\n")
		risk.Summary = "测试盘拦截，因为止损止盈算不出来"
		fills.Summary = "测试盘未成交，因为止损止盈算不出来"
		fills.Artifact = fills.Summary + "\n" + err.Error()
		return risk, fills
	}
	liq, err := trading.IsolatedLiqPrice(side, mark, cfg.Leverage, trading.DefaultMaintMarginRate)
	if err != nil {
		lines = append(lines, "拦截 "+err.Error())
		risk.Artifact = strings.Join(lines, "\n")
		risk.Summary = "测试盘拦截，因为强平价算不出来"
		fills.Summary = "测试盘未成交，因为强平价算不出来"
		fills.Artifact = fills.Summary + "\n" + err.Error()
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
		risk.Summary = "测试盘拦截，因为止损越过强平"
		fills.Summary = "测试盘未成交，因为止损越过强平"
		fills.Artifact = fills.Summary
		return risk, fills
	}
	lines = append(lines, "止损在强平价之前")
	if allow == nil {
		lines = append(lines, "拦截：没有决策")
		risk.Artifact = strings.Join(lines, "\n")
		risk.Summary = "测试盘拦截，因为没有决策"
		fills.Summary = "测试盘未成交，因为没有决策"
		fills.Artifact = fills.Summary
		return risk, fills
	}
	if !*allow {
		lines = append(lines, "决策 deny，拦截，未发单")
		risk.Artifact = strings.Join(lines, "\n")
		risk.Summary = "测试盘拦截，因为决策拒绝"
		fills.Summary = "测试盘未成交，因为决策拒绝"
		fills.Artifact = fills.Summary
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
		risk.Summary = "测试盘撮合拒绝"
		fills.Error = err.Error()
		fills.Summary = "测试盘未成交，因为撮合拒绝"
		fills.Artifact = err.Error()
		return risk, fills
	}
	lines = append(lines, "决策 allow，测试盘撮合放行")
	risk.Artifact = strings.Join(lines, "\n")
	risk.Summary = "测试盘风控放行"
	fills.Summary = "测试盘成交，" + sideWord(sideName)
	fills.Artifact = fmt.Sprintf("order %s\nstatus %s\nside %s\nqty %s\nprice %s",
		fill.OrderID, fill.Status, fill.Side, formatNum(fill.Qty), formatNum(fill.Price))
	return risk, fills
}

func sideWord(side string) string {
	if side == "long" {
		return "做多"
	}
	if side == "short" {
		return "做空"
	}
	return ""
}

func sideSentence(side string) string {
	word := sideWord(side)
	if word == "" {
		return "提案没有方向"
	}
	return "提案" + word
}

func priceSentence(mark float64) string {
	return strconv.FormatFloat(mark, 'f', 2, 64)
}

func riskReason(reason string) string {
	switch reason {
	case "funding_extreme":
		return "资金费率过高"
	case trading.ReasonStopBeyondLiquidation:
		return "止损越过强平"
	default:
		return "风控没有通过"
	}
}

func shortChinese(message string) string {
	text := strings.ToLower(message)
	switch {
	case strings.Contains(text, "proposal text") || strings.Contains(message, "没收到提案"):
		return "审核没收到提案"
	case strings.Contains(message, "方向无法使用"):
		return "提案说不清方向"
	case strings.Contains(message, "审核答复无法使用"):
		return "审核没有说否决还是通过"
	case strings.Contains(text, "empty response"), strings.Contains(message, "没有返回正文"):
		return "模型没有回答"
	case strings.Contains(text, "timeout"), strings.Contains(text, "deadline"), strings.Contains(message, "超时"):
		return "这一步超时"
	case strings.Contains(message, "没有可用账号"):
		return "没有可用模型"
	case strings.Contains(message, "行情"):
		return "测试盘行情没拿到"
	default:
		return "这一步失败"
	}
}

func formatNum(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}
