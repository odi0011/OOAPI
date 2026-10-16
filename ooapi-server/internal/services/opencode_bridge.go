package services

import "strings"

/*
OpenCode 桥接识别。

**背景**：OpenCode Zen 的免费档在服务端做了客户端校验 —— 非官方客户端
一律 403 FreeTierError（"can only be used from within OpenCode"）。
实测排除了 UA、请求头、ID 格式、TLS 指纹等所有可伪造的层面：校验绑定在
官方客户端进程的行为特征上，纯 HTTP 客户端无法通过（见 bridge 包注释）。

**方案**：在本机跑一个官方 `opencode serve` 进程（headless 服务），
网关把请求交给它代为调用 —— 对上游来说这就是货真价实的官方客户端。
网关与 serve 之间走本机回环，不经过公网。

**识别规则**：厂商是 opencode 且地址是 opencode.ai 官方域的渠道自动走桥接。
按域名 + 厂商双重判断而不是让管理员手工选 method：
  - method 字段在管理端是「接入方式」选择器（api/设备码/订阅），
    为一个传输细节新增一个选项会让所有既有渠道的语义变模糊；
  - opencode.ai 这个域下的渠道只有这一种正确走法 ——
    自动识别比让每个管理员都记得切换更不容易配错。

桥接对上游模型名的解析没有影响：请求体里仍然是该账号配置的模型名，
由 serve 按同样的名字调上游。
*/

// OpenCodeBridgeBase 是桥接 serve 的默认监听地址。
// 环境变量 OOAPI_OPENCODE_BRIDGE 可以覆盖（测试与多实例部署用）。
const OpenCodeBridgeBase = "http://127.0.0.1:4096"

// IsOpenCodeUpstreamHost 判断一个上游地址是否指向 OpenCode 官方域。
func IsOpenCodeUpstreamHost(baseURL string) bool {
	trimmed := strings.ToLower(strings.TrimSpace(baseURL))
	if trimmed == "" {
		return false
	}
	// 去掉协议前缀后取主机名部分。
	host := trimmed
	if i := strings.Index(host, "://"); i >= 0 {
		host = host[i+3:]
	}
	if i := strings.IndexAny(host, "/?#"); i >= 0 {
		host = host[:i]
	}
	// 去掉可能的端口。
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	return host == "opencode.ai" || strings.HasSuffix(host, ".opencode.ai")
}

/*
UsesOpenCodeBridge 报告一个账号是否应走本机 OpenCode 桥接。

**只有 Zen 端点（/zen/v1）需要桥接**：实测 Zen 免费档在服务端做客户端校验，
非官方客户端一律 403 FreeTierError。

**Go 端点（/zen/go/v1）不桥接**：官方文档明确它面向「OpenCode 与其他
coding agents」，实测直连无客户端校验，而且比桥接更好：

  - **支持工具调用**：实测 cat-jam-free 的 tool_calls 两轮往返完全正确
    （桥接做不到 —— serve 的 API 不接受外部工具 schema，
    导致 Claude Code / Codex 的写文件任务全部静默失败）；
  - **更快**：实测 357 tok/s（桥接约 190 tok/s）；
  - **无进程风险**：没有 serve 的 shell 工具执行面。

两者混在同一个 base_url 前缀下（/zen/v1 与 /zen/go/v1），所以按路径区分。
*/
func UsesOpenCodeBridge(ch *UpstreamChannel) bool {
	if ch == nil {
		return false
	}
	if ch.Bridge {
		return true
	}
	if !strings.EqualFold(strings.TrimSpace(ch.Vendor), "opencode") {
		return false
	}
	if !IsOpenCodeUpstreamHost(ch.BaseURL) {
		return false
	}
	// Go 端点：直连（支持工具、更快、无校验）。
	if IsGoEndpoint(ch.BaseURL) {
		return false
	}
	return true
}

// IsGoEndpoint 判断地址是否指向 OpenCode 的 Go 门面（面向第三方客户端）。
func IsGoEndpoint(baseURL string) bool {
	lower := strings.ToLower(strings.TrimSpace(baseURL))
	return strings.Contains(lower, "/zen/go/") || strings.HasSuffix(lower, "/zen/go")
}
