package handlers

import (
	"testing"
	"time"
)

// TestIsNotApprovedResponse 覆盖「账号被标记为未批准渠道」的识别。
//
// 这个判断的分量在于：误判成凭据失效会让管理员反复重绑（原项目实测连绑 4 次无效），
// 误判成普通参数错误又会让他反复调配置。两种弯路都踩过。
func TestIsNotApprovedResponse(t *testing.T) {
	positives := []string{
		`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`,
		`{"code":11140,"msg":"request illegal","displayMsg":{"zh":"内容未通过安全审核"}}`,
		`Illegal API invocation from an unapproved channel`,
		`{"error":{"message":"Request illegal"}}`,
	}
	for _, body := range positives {
		if !isNotApprovedResponse(body) {
			t.Fatalf("not detected: %s", body)
		}
	}
	negatives := []string{
		"",
		`{"error":{"message":"model not found"}}`,
		`{"code":"invalid_api_key"}`,
		`{"error":{"message":"rate limit exceeded"}}`,
	}
	for _, body := range negatives {
		if isNotApprovedResponse(body) {
			t.Fatalf("false positive: %s", body)
		}
	}
}

// TestShouldTryNextEndpoint 端点切换的边界：只对「路径/协议不被接受」生效。
func TestShouldTryNextEndpoint(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   bool
		why    string
	}{
		{404, `{"error":"not found"}`, true, "路径不存在，换个协议形状可能就对"},
		{400, `{"error":{"type":"ModelProtocolUnsupported"}}`, true, "上游明说协议不支持"},
		{405, "method not allowed", true, "方法不匹配"},
		{422, "unprocessable", true, "形状不被接受"},
		{400, `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`, false, "风控标记换端点无用且会加重风控"},
		{401, "unauthorized", false, "鉴权失败换端点无用"},
		{403, `{"code":11140,"msg":"request illegal"}`, false, "风控（403 档）"},
		{429, "rate limited", false, "限流换端点无用"},
		{500, "internal", false, "上游自身故障"},
		{502, "bad gateway", false, "网关故障"},
	}
	for _, tc := range cases {
		if got := shouldTryNextEndpoint(tc.status, tc.body); got != tc.want {
			t.Fatalf("status=%d got=%v want=%v (%s)", tc.status, got, tc.want, tc.why)
		}
	}
}

// TestShouldCooldownOnStatusRiskControl 风控标记即使状态码是 400 也必须冷却。
func TestShouldCooldownOnStatusRiskControl(t *testing.T) {
	riskBody := `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`
	if !shouldCooldownOnStatus(400, riskBody) {
		t.Fatal("risk-control 400 must cool down (otherwise it hammers upstream)")
	}
	// 普通 400 仍然不冷却（是请求的问题，不是账号的问题）。
	if shouldCooldownOnStatus(400, `{"error":"bad request"}`) {
		t.Fatal("plain 400 must not cool the account")
	}
	// 429 照旧冷却。
	if !shouldCooldownOnStatus(429) {
		t.Fatal("429 must cool down")
	}
}

// TestEndpointCandidatesFor 覆盖候选端点的生成与顺序。
func TestEndpointCandidatesFor(t *testing.T) {
	// 首选在前，另外两个协议补齐，且不重复。
	got := endpointCandidatesFor(7, "claude-*", "/messages")
	if len(got) != 3 {
		t.Fatalf("candidates = %#v", got)
	}
	if got[0] != "/messages" {
		t.Fatalf("preferred must be first: %#v", got)
	}
	seen := map[string]bool{}
	for _, path := range got {
		if seen[path] {
			t.Fatalf("duplicate candidate %q in %#v", path, got)
		}
		seen[path] = true
	}
	for _, want := range []string{"/chat/completions", "/responses", "/messages"} {
		if !seen[want] {
			t.Fatalf("missing %q in %#v", want, got)
		}
	}
	// 带前缀的路径：候选必须落在同一个前缀下（有的上游是 /openai/v1）。
	prefixed := endpointCandidatesFor(7, "x", "/openai/v1/messages")
	prefixOK := false
	for _, path := range prefixed {
		if path == "/openai/v1/chat/completions" {
			prefixOK = true
		}
		if path == "/chat/completions" {
			t.Fatalf("prefix lost: %#v", prefixed)
		}
	}
	if !prefixOK {
		t.Fatalf("prefixed candidates wrong: %#v", prefixed)
	}
}

// TestEndpointWinnerCache 验证「记住成功的端点」这一层。
func TestEndpointWinnerCache(t *testing.T) {
	rememberEndpointWinner(101, "claude-x", "/chat/completions", "/messages")
	got := endpointCandidatesFor(101, "claude-x", "/chat/completions")
	if len(got) == 0 || got[0] != "/messages" {
		t.Fatalf("winner not preferred: %#v", got)
	}
	// 不同模型的缓存互不干扰：同一上游对不同模型的协议支持可能不同。
	other := endpointCandidatesFor(101, "grok-y", "/chat/completions")
	if len(other) == 0 || other[0] != "/chat/completions" {
		t.Fatalf("cache leaked across models: %#v", other)
	}
	// 不同账号互不干扰。
	otherChannel := endpointCandidatesFor(202, "claude-x", "/chat/completions")
	if len(otherChannel) == 0 || otherChannel[0] != "/chat/completions" {
		t.Fatalf("cache leaked across channels: %#v", otherChannel)
	}
	// 失败时立即失效：否则会继续撞一个已坏的路径。
	forgetEndpointWinner(101, "claude-x", "/chat/completions")
	after := endpointCandidatesFor(101, "claude-x", "/chat/completions")
	if len(after) == 0 || after[0] != "/chat/completions" {
		t.Fatalf("forget did not work: %#v", after)
	}
}

/*
TestEndpointWinnerScopedByPreferred 验证缓存按「首选路径」隔离。

首选路径来自管理员配置的 model_paths。改配置后应当重新协商：
旧配置下缓存的赢家不该继续生效 —— 那种情况下请求会被静默打到
与当前配置无关的端点上，而症状看起来与配置完全无关（实测踩过：
图片在 Anthropic 转换里被压平，用户以为「网关不支持看图」）。
*/
func TestEndpointWinnerScopedByPreferred(t *testing.T) {
	// 在「首选 chat」下记住 messages 赢家。
	rememberEndpointWinner(404, "model-z", "/chat/completions", "/messages")

	// 同一账号同一模型，但配置改成了首选 /messages：不该命中上面那条。
	got := endpointCandidatesFor(404, "model-z", "/messages")
	if len(got) == 0 || got[0] != "/messages" {
		t.Fatalf("首选为 messages 时应仍以 messages 开头: %#v", got)
	}
	if len(got) > 1 && got[1] != "/chat/completions" {
		t.Fatalf("非首选顺序应为默认排列: %#v", got)
	}

	// 首选仍是 chat 时，缓存照旧生效（确认隔离没有把正常路径也切断）。
	same := endpointCandidatesFor(404, "model-z", "/chat/completions")
	if len(same) == 0 || same[0] != "/messages" {
		t.Fatalf("首选未变时缓存应生效: %#v", same)
	}
}

// TestEndpointWinnerExpires 过期后不再优先。
func TestEndpointWinnerExpires(t *testing.T) {
	rememberEndpointWinner(303, "m", "/chat/completions", "/messages")
	// 手动把过期时间改到过去。
	key := endpointCacheKey(303, "m", "/chat/completions")
	endpointWinnerMu.Lock()
	endpointWinners[key] = endpointWinner{path: "/messages", expires: time.Now().Add(-time.Second)}
	endpointWinnerMu.Unlock()
	got := endpointCandidatesFor(303, "m", "/chat/completions")
	if len(got) == 0 || got[0] != "/chat/completions" {
		t.Fatalf("expired winner still preferred: %#v", got)
	}
}

// TestFriendlyUpstreamMessageRiskControl 风控要给出正确方向（换账号，而不是重绑）。
func TestFriendlyUpstreamMessageRiskControl(t *testing.T) {
	msg := friendlyUpstreamMessage(400, `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`)
	if msg == "" || !contains(msg, "换用") {
		t.Fatalf("risk-control message unhelpful: %q", msg)
	}
	if contains(msg, "重新登录") && !contains(msg, "通常无效") {
		t.Fatalf("risk-control message must not send the admin to re-login: %q", msg)
	}
}

// contains 是测试用的子串判断（避免为一行断言引 strings）。
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestIsClientErrorAllowsRetryOnRiskControl 是「WorkBuddy 被风控时自动换账号」的核心断言。
//
// 调度层用 isClientError 决定「是否放弃重试」：
//
//	· 普通 4xx（请求写错了）→ 换账号也没用，放弃；
//	· 风控标记（11128/11140，同样是 400）→ **账号**被标记了，别的账号可能没事，
//	  必须继续尝试下一个候选账号。
//
// 如果这里返回 true，用户会看到 11128 错误，而实际上换个账号就能成功 ——
// 正是「他坏了就坏了，系统自动调度到其它可用账号」这条要求。
func TestIsClientErrorAllowsRetryOnRiskControl(t *testing.T) {
	risk := newUpstreamError(400,
		`上游返回 400：{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`,
		true)
	if isClientError(risk) {
		t.Fatal("risk-control 400 must NOT stop retrying: another account may work")
	}
	// 对照组：普通 400（参数错、模型名错）应当立刻放弃重试。
	plain := newUpstreamError(400, `上游返回 400：{"error":{"message":"invalid model"}}`, false)
	if !isClientError(plain) {
		t.Fatal("plain 400 must stop retrying (switching accounts cannot help)")
	}
	// 402 欠费照旧放弃（换账号也一样，因为钱不会自己到账）。
	if !isClientError(newUpstreamError(402, "余额不足", true)) {
		t.Fatal("402 must stop retrying")
	}
	// 429 限流要继续试下一个账号（可自愈，且别的账号可能没事）。
	if isClientError(newUpstreamError(429, "rate limited", true)) {
		t.Fatal("429 must continue retrying on other accounts")
	}
	// 11140（403 档的风控）同样要换账号。
	risk403 := newUpstreamError(403, `{"code":11140,"msg":"request illegal"}`, true)
	if isClientError(risk403) {
		t.Fatal("403 risk-control must not stop retrying")
	}
}
