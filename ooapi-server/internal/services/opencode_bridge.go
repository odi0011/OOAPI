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

// UsesOpenCodeBridge 报告一个账号是否应走本机 OpenCode 桥接。
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
	return IsOpenCodeUpstreamHost(ch.BaseURL)
}
