package handlers

/*
端点自动协商（原项目 endpoint-fallback 的 Go 版）。

问题：聚合型上游常在同一 base_url 下按模型分走三种协议 ——
Claude 走 /messages、Grok 走 /responses、其余走 /chat/completions。
本站的正式做法是管理员在账号里配「按模型的协议路由」（model_paths）。
但配置是会出错的（漏了一个模型、上游改了支持范围、或者管理员根本不知道
这个模型该走哪个协议），此时上游会回一句
`ModelProtocolUnsupported` 或 404 —— 用户看到的是「模型不可用」，
而真实原因只是「路径选错了」。

这一段做的就是：**在明确是「路径/协议不被接受」时，自动试另外两个端点。**
成功后记住赢家（按 账号+模型+首选协议 缓存 10 分钟），后续请求直接命中，
不再重复试错。

边界（与原实现一致，也是安全底线）：
  · 只有**上游明确拒绝**（400/404/405/415/422/501）才换端点 ——
    网络错误、超时、限流、鉴权失败、风控标记都不换：
    那些换协议也解决不了，重试只会把问题放大。
  · **已经开始给客户端写数据就不再换**（换协议意味着重新生成，
    用户会看到两段内容拼接）。所以只在「拿到响应、还没写一个字」时判定。
  · 每次请求最多试 3 个端点，失败时保留**最初的**错误
    （否则用户看到的是最后那个 404，而不是真正的参数错误）。
*/

import (
	"hash/fnv"
	"strconv"
	"strings"
	"sync"
	"time"
)

// endpointSuffixes 是三种协议对应的路径后缀，按「最通用 → 最专用」排列。
var endpointSuffixes = []struct {
	protocol string
	suffix   string
}{
	{"openai", "/chat/completions"},
	{"responses", "/responses"},
	{"anthropic", "/messages"},
}

// endpointFallbackTTL 是「赢家端点」的缓存时长。
const endpointFallbackTTL = 10 * time.Minute

// maxEndpointCandidates 缓存条目上限（正常远达不到；防止异常配置把表撑大）。
const maxEndpointCandidates = 512

type endpointWinner struct {
	path    string
	expires time.Time
}

var (
	endpointWinnerMu sync.Mutex
	endpointWinners  = map[uint64]endpointWinner{}
)

// endpointCacheKey 由「账号 + 模型 + 首选路径」决定。
//
// 带上首选路径（原项目同样把它算进 key）：首选来自 model_paths 配置，
// 管理员改了配置就应当重新协商，而不是继续沿用旧配置下缓存 10 分钟的赢家。
// 只按账号+模型缓存时，改完配置的请求还会被打到旧端点上，且症状与配置无关。
func endpointCacheKey(channelID int64, model, preferred string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(strconv.FormatInt(channelID, 10)))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(model))
	_, _ = h.Write([]byte{0})
	_, _ = h.Write([]byte(preferred))
	return h.Sum64()
}

// rememberEndpointWinner 记下某个账号+模型上验证可用的路径。
func rememberEndpointWinner(channelID int64, model, preferred, path string) {
	key := endpointCacheKey(channelID, model, preferred)
	endpointWinnerMu.Lock()
	defer endpointWinnerMu.Unlock()
	now := time.Now()
	for k, v := range endpointWinners {
		if now.After(v.expires) {
			delete(endpointWinners, k)
		}
	}
	if len(endpointWinners) >= maxEndpointCandidates {
		// 满了就清空重建：正常规模远达不到，真到了说明配置异常。
		endpointWinners = map[uint64]endpointWinner{}
	}
	endpointWinners[key] = endpointWinner{path: path, expires: now.Add(endpointFallbackTTL)}
}

// forgetEndpointWinner 在端点失败时立即失效缓存，避免继续撞一个已坏的路径。
func forgetEndpointWinner(channelID int64, model, preferred string) {
	endpointWinnerMu.Lock()
	delete(endpointWinners, endpointCacheKey(channelID, model, preferred))
	endpointWinnerMu.Unlock()
}

/*
endpointCandidatesFor 返回本次请求要尝试的路径列表（首选在前）。

preferred 是原本该用的路径（来自 model_paths 或默认值）；
有缓存赢家时把它提到最前，避免每次都从错的那条开始试。
只有配置了 base_url 的账号才有意义；同一条路径不会重复出现。
*/
func endpointCandidatesFor(channelID int64, model, preferred string) []string {
	if channelID <= 0 || preferred == "" {
		return []string{preferred}
	}
	seen := map[string]struct{}{}
	out := []string{}

	appendPath := func(path string) {
		if path == "" {
			return
		}
		if _, dup := seen[path]; dup {
			return
		}
		seen[path] = struct{}{}
		out = append(out, path)
	}

	// 缓存命中：先试它。
	endpointWinnerMu.Lock()
	winner, okWinner := endpointWinners[endpointCacheKey(channelID, model, preferred)]
	endpointWinnerMu.Unlock()
	if okWinner && time.Now().Before(winner.expires) {
		appendPath(winner.path)
	}
	appendPath(preferred)

	// 决策协议不能退回对话端点。chat 请求体和 systemone 请求体不是同一种东西，
	// 换过去只会把 state/questions 发给一个不认识它们的接口。
	if strings.HasSuffix(preferred, "/systemone") {
		if len(out) > 1 && !strings.HasSuffix(out[0], "/systemone") {
			out = []string{preferred}
		}
		return out
	}

	// 把「base_url 自带的路径前缀」也考虑进来：
	// 有的上游是 https://host/openai/v1（带 /v1 段），有的直接是 https://host。
	// 前缀从 preferred 里剥出来，保证候选路径落在同一个前缀下。
	prefix := ""
	for _, entry := range endpointSuffixes {
		if len(preferred) > len(entry.suffix) && preferred[len(preferred)-len(entry.suffix):] == entry.suffix {
			prefix = preferred[:len(preferred)-len(entry.suffix)]
			break
		}
	}
	for _, entry := range endpointSuffixes {
		appendPath(prefix + entry.suffix)
	}
	return out
}

/*
shouldTryNextEndpoint 判断这次上游拒绝是否值得换一个端点重试。

只认「路径/协议不被接受」这一类：上游明确说了不认识这个请求，
换个协议形状可能就对上了。其余（限流、鉴权、风控、断流、5xx）
换端点解决不了，重试只会浪费一次上游往返并放大风控。
*/
func shouldTryNextEndpoint(status int, body string) bool {
	// 风控标记优先排除：WorkBuddy 的 11128/11140 用 400 返回，
	// 但那是账号被标记，换路径没有任何用，而且反复重试会加重风控。
	if isNotApprovedResponse(body) {
		return false
	}
	switch status {
	case 400, 404, 405, 415, 422, 501:
		return true
	}
	return false
}

/*
isNotApprovedResponse 识别「账号被上游标记为未批准渠道」。

腾讯 WorkBuddy / CodeBuddy 对个人账号转 API 的风控有两档，实测（原项目记录）：

	11128（400）Illegal API invocation from an unapproved channel
	11140（403）request illegal + 内容安全审核提示

关键事实：**凭据仍然有效**。归成「凭据失效」会把人引进重新绑定的死胡同
（原项目实测连绑 4 次全部无效）；而按普通 400 处理又会诱导重试、加重风控。
正确定位是：可换账号 + 长冷却。
*/
func isNotApprovedResponse(body string) bool {
	if body == "" {
		return false
	}
	lower := strings.ToLower(body)
	for _, hint := range []string{
		"11128", "11140",
		"unapproved channel",
		"illegal api invocation",
		"request illegal",
	} {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}
