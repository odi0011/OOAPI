package handlers

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"ooapi/internal/auth"
	"ooapi/internal/db"
	"ooapi/internal/netguard"
	"ooapi/internal/services"
)

// 对外 OpenAI 兼容接口。
//
// 完整链路：令牌鉴权 → 分组校验 → 账号调度 → 上游转发 → 计费 → 记日志。
// 任何一环出错都要给出可排查的提示，而不是笼统的「出错了」。

// 单次请求允许的上游尝试次数。
// 设上限是为了避免「所有账号都挂」时把请求拖到超时。
const maxChannelAttempts = 3

// chatRequest 是 /v1/chat/completions 的请求体。
//
// 只声明我们需要读的字段，其余原样透传给上游 ——
// 上游支持的新参数（如 tools、response_format）不该被网关丢弃。
type chatRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
	// StreamOptions 让上游在流式响应末尾带上 usage。
	// 没有它就收不到 token 用量，流式调用将无法精确计费。
	StreamOptions *struct {
		IncludeUsage bool `json:"include_usage"`
	} `json:"stream_options,omitempty"`
}

// ChatCompletions 处理 OpenAI Chat Completions 协议的请求。
//
// 这是最通用的一条路径：SDK、脚本、各类兼容客户端都走它。
// 内部链路由 protocol.go 的公共实现承担，这里只做协议外壳的处理。
func ChatCompletions(c *gin.Context) {
	start := time.Now()

	token, err := authenticateAPIKey(c)
	if err != nil {
		writeOpenAIError(c, http.StatusUnauthorized, err.Error(), "invalid_api_key")
		return
	}

	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 32<<20))
	if err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "读取请求体失败", "invalid_request_error")
		return
	}

	var req chatRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeOpenAIError(c, http.StatusBadRequest, "请求体不是合法 JSON", "invalid_request_error")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeOpenAIError(c, http.StatusBadRequest, "缺少 model 参数", "invalid_request_error")
		return
	}

	group, okAccess := checkAccess(c, token, req.Model, writeOpenAIError)
	if !okAccess {
		return
	}

	// 流式：原样透传上游事件
	if req.Stream {
		relayUpstream(c, token, group, req.Model, body, start, &chatPassthrough{}, writeOpenAIError)
		return
	}

	call, okCall := callUpstream(c.Request.Context(), c, token, group, req.Model, body, start, writeOpenAIError)
	if !okCall {
		return
	}
	c.Data(http.StatusOK, "application/json", call.Body)
}

// upstreamUsage 是从上游响应里解析出的 token 用量。
type upstreamUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
	// CachedTokens 是少数上游（如 Antigravity）放在 usage 顶层的缓存命中数。
	// OpenAI 口径放在 prompt_tokens_details；两者同时出现时以 details 为准。
	CachedTokens  int `json:"cached_tokens,omitempty"`
	PromptDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details"`
}

// cachedTokenCount 返回本次用量里的缓存命中 token。
// prompt_tokens 已经包含这部分，结算时不能再按输入价加一遍。
func (u upstreamUsage) cachedTokenCount() int {
	if u.PromptDetails != nil && u.PromptDetails.CachedTokens > 0 {
		return u.PromptDetails.CachedTokens
	}
	if u.CachedTokens > 0 {
		return u.CachedTokens
	}
	if u.PromptDetails != nil {
		return u.PromptDetails.CachedTokens
	}
	return 0
}

// forwardJSON 非流式转发。
//
// 返回值里的 error 是 *upstreamError 类型，调用方据此判断
// 该不该给账号上冷却（见 classifyUpstreamError 的说明）。
func forwardJSON(ctx context.Context, ch *services.UpstreamChannel, body []byte, model string) ([]byte, upstreamUsage, error) {
	if len(ch.APIKeys) == 0 {
		return nil, upstreamUsage{}, newUpstreamError(0, "账号未配置上游密钥", true)
	}

	/*
		客户端按官方模型名调用（deepseek-flash），而上游只认它自己的叫法
		（deepseek-v4.1-flash）—— 先解析出该账号实际该用的名字。
		协议路由与请求体构造都基于这个名字，否则上游会收到它不认识的 id。
	*/
	upstreamModel := services.UpstreamModelFor(ch, model)
	if upstreamModel == "" {
		return nil, upstreamUsage{}, newUpstreamError(0, "账号「"+ch.Name+"」不支持模型 "+model, false)
	}

	/*
		上游协议可能按模型区分（聚合型上游常见），路径与请求形状都要跟着变。

		配置（model_paths）是首选依据；配置漏了或上游改了支持范围时，
		自动试另外两个端点 —— 见 endpoint_fallback.go。

		但固定协议的渠道（设备授权 / 订阅登录）不参与协商：它们的传输层
		只认一条路径，试别的必然被拒，而那条「不支持的请求路径」会掩盖
		真正的上游错误（实测：WorkBuddy 的真实失败原因被 /responses 顶掉了）。
	*/
	preferredPath := upstreamPathForModel(ch, upstreamModel)
	candidates := []string{preferredPath}
	if !services.IsFixedProtocolChannel(ch) {
		candidates = endpointCandidatesFor(ch.ID, upstreamModel, preferredPath)
	}

	var (
		raw         []byte
		protocol    string
		firstStatus int
		firstRaw    string
		gotResponse bool
	)
	for index, candidate := range candidates {
		proto := upstreamProtocol(candidate)
		upstreamBody, err := buildUpstreamBody(proto, body, upstreamModel)
		if err != nil {
			return nil, upstreamUsage{}, newUpstreamError(0, "构造上游请求失败："+err.Error(), false)
		}

		reqCtx, cancel := context.WithTimeout(ctx, 600*time.Second)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodPost,
			strings.TrimRight(ch.BaseURL, "/")+candidate, bytes.NewReader(upstreamBody))
		if err != nil {
			cancel()
			return nil, upstreamUsage{}, newUpstreamError(0, err.Error(), false)
		}
		setUpstreamHeadersFor(req, ch.APIKeys[0], ch, proto)

		// 出口选择：配了 proxy_url 的账号走代理（见 protocol.go），
		// 未配置时走共享客户端，行为与从前一致。
		resp, err := doUpstreamRequest(req, ch)
		if err != nil {
			cancel()
			return nil, upstreamUsage{}, upstreamRequestError(err)
		}

		bodyBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		cancel()
		if readErr != nil {
			return nil, upstreamUsage{}, newUpstreamError(0, "读取上游响应失败："+readErr.Error(), true)
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			raw, protocol, gotResponse = bodyBytes, proto, true
			if candidate != preferredPath {
				rememberEndpointWinner(ch.ID, upstreamModel, preferredPath, candidate)
				// 端点协商必须留痕：这个切换是静默的，出问题时
				// （如图片在协议转换里被压平）没有任何线索可查。
				log.Printf("[gateway] 账号「%s」模型 %s 首选端点 %s 被拒，改用 %s",
					ch.Name, upstreamModel, preferredPath, candidate)
			}
			break
		}

		/*
			保留「第一个有意义的错误」。

			原项目的经验：全部路径失败时不能用最后那条 404 覆盖最初的错误 ——
			前者只是「这条路径不存在」的噪音，后者才是管理员要看的原因。
			所以首个错误优先，只在首个本身就是 404 时才让位给后来的。
		*/
		if firstStatus == 0 || (firstStatus == http.StatusNotFound && resp.StatusCode != http.StatusNotFound) {
			firstStatus, firstRaw = resp.StatusCode, string(bodyBytes)
		}
		// 只有「路径/协议不被接受」才换下一个；其余（限流/鉴权/风控）立刻返回。
		if index == len(candidates)-1 || !shouldTryNextEndpoint(resp.StatusCode, string(bodyBytes)) {
			break
		}
		log.Printf("[gateway] 账号「%s」端点 %s 拒绝模型 %s（HTTP %d），换下一个端点",
			ch.Name, candidate, upstreamModel, resp.StatusCode)
		forgetEndpointWinner(ch.ID, upstreamModel, preferredPath)
	}

	if !gotResponse {
		message := fmt.Sprintf("上游返回 %d：%s", firstStatus, truncate(firstRaw, 300))
		if hint := friendlyUpstreamMessage(firstStatus, firstRaw); hint != "" {
			message = hint + "（上游原文：" + truncate(firstRaw, 200) + "）"
		}
		return nil, upstreamUsage{}, newUpstreamError(firstStatus,
			message, shouldCooldownOnStatus(firstStatus, firstRaw))
	}
	// 非 chat 协议的上游响应要先翻回通用语，后续计费与日志才能统一读字段。
	if protocol != "openai" {
		converted, err := convertUpstreamResponse(protocol, raw, upstreamModel)
		if err != nil {
			return nil, upstreamUsage{}, newUpstreamError(0, "转换上游响应失败："+err.Error(), false)
		}
		raw = converted
	}

	var parsed struct {
		Usage *upstreamUsage `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(raw, &parsed)

	// 部分中转会返回 200 但内容里带 error，这种情况要按失败处理，
	// 否则会把错误响应当成成功计费。
	if parsed.Error != nil && parsed.Error.Message != "" {
		return nil, upstreamUsage{}, newUpstreamError(0, "上游返回错误："+parsed.Error.Message, true)
	}

	usage := upstreamUsage{}
	if parsed.Usage != nil {
		usage = *parsed.Usage
	}
	return raw, usage, nil
}

// convertUpstreamResponse 把非 chat 协议的上游响应翻回 chat-completions。
func convertUpstreamResponse(protocol string, raw []byte, model string) ([]byte, error) {
	switch protocol {
	case "anthropic":
		return anthropicToChatResponse(raw, model)
	case "responses":
		return responsesToChatResponse(raw, model)
	default:
		return raw, nil
	}
}

// ---------- 上游错误分类 ----------

/*
upstreamError 带上「这次失败该不该让账号进冷却」的判断。

为什么必须分类：早先所有失败都一视同仁地把账号冷却 60 秒。
于是上游回一个 400（「这个模型不支持这个协议」）就能把一个
完全健康的账号踢出调度一分钟 —— 单个账号的分组直接变成
「没有可用账号」，而账号本身什么问题都没有。

	4xx（除 429）：请求本身的问题（参数错、模型不存在、协议不符）。
	              换账号通常也没用，但绝不能冷却账号。
	429 / 5xx：  上游过载或故障，值得冷却一会儿再试。
	网络层错误：  连不上、超时，同样值得冷却。
*/
type upstreamError struct {
	Status  int
	Message string
	// Cool 表示这次失败是否说明账号本身不健康。
	Cool bool
}

func (e *upstreamError) Error() string { return e.Message }

func newUpstreamError(status int, message string, cool bool) *upstreamError {
	return &upstreamError{Status: status, Message: message, Cool: cool}
}

// shouldCooldownOnStatus 判断某个 HTTP 状态码是否说明账号不健康。
func shouldCooldownOnStatus(status int, body ...string) bool {
	/*
		风控标记（WorkBuddy 11128/11140）即使状态码是 400 也必须冷却：
		账号被上游标记了，立刻重试只会加重风控。原项目的处理是「换渠道 + 6 小时冷却」，
		本站沿用同一策略（长冷却在 MarkChannelFailureWithCooldown 里按文案判定）。
	*/
	if len(body) > 0 && isNotApprovedResponse(body[0]) {
		return true
	}
	switch {
	case status == http.StatusTooManyRequests: // 429：限流，冷却后重试有意义
		return true
	case status == http.StatusPaymentRequired:
		// 402：上游账号欠费。这确实是账号的问题（在充值前它一直不可用），
		// 因此要冷却 —— 但冷却时长在 MarkChannelFailureWithCooldown 里
		// 会按「付费问题」延长，因为 60 秒后钱不会自己到账。
		return true
	case status >= 500: // 上游自身故障
		return true
	case status >= 400: // 其余 4xx：请求的问题，不是账号的问题
		return false
	default:
		return true
	}
}

// isClientError 判断错误是否属于「换账号也救不回来」。
// 这类错误可以直接停止重试。
func isClientError(err error) bool {
	var ue *upstreamError
	if errors.As(err, &ue) {
		/*
			风控标记是例外：它是「这个账号被标记了」，不是「请求写错了」。

			原项目的结论是「可换渠道重试（别的账号可能没事）+ 长冷却」——
			把它归成客户端错误会直接放弃这次请求，而换个账号本可以成功。
			这里因此返回 false，让调度继续尝试下一个候选账号。
		*/
		if isNotApprovedResponse(ue.Message) {
			return false
		}
		if ue.Status == http.StatusPaymentRequired {
			// 欠费：重试一百次也一样。实测中一次请求因此重试了 3 次，
			// 每次都白等一轮往返，用户等得更久、上游也被多打两次。
			return true
		}
		return ue.Status >= 400 && ue.Status < 500 && ue.Status != http.StatusTooManyRequests
	}
	return false
}

// friendlyUpstreamMessage 把上游的原始错误翻成管理员一眼能懂的话。
//
// 上游的错误文案（如 "Insufficient account funds"）说的是「谁的」钱并不明确，
// 用户看到会以为是自己账号余额不足，跑去充值却发现余额充足 ——
// 实际是后台配置的那个上游账号没钱了。这里把归属说清楚。
func friendlyUpstreamMessage(status int, raw string) string {
	/*
		风控标记优先于状态码判断。

		腾讯 WorkBuddy / CodeBuddy 用 400 返回 "Illegal API invocation from an
		unapproved channel"（11128）或 403 返回 request illegal（11140）——
		凭据本身是有效的，是账号被标记了。按普通 4xx 处理会让管理员以为
		「请求写错了」而反复调参；按凭据过期处理又会让他反复重绑（原项目实测
		连绑 4 次都无效）。正确方向是：换别的账号，等风控解除。
	*/
	if isNotApprovedResponse(raw) {
		return "上游把这个账号标记为「未批准的调用渠道」（风控，凭据仍有效）。请换用该厂商的其他账号，或等一段时间再试；重新登录同一账号通常无效"
	}
	switch status {
	case http.StatusPaymentRequired:
		return "上游账号余额不足，请在后台给该账号充值或切换其他账号"
	case http.StatusUnauthorized, http.StatusForbidden:
		if strings.Contains(strings.ToLower(raw), "insufficient") {
			return "上游账号余额不足或密钥无效，请在后台检查该账号配置"
		}
		return "上游拒绝了本次请求：密钥无效或权限不足，请在后台检查该账号配置"
	case http.StatusTooManyRequests:
		return "上游返回限流（429），请稍后重试"
	}
	return ""
}

// upstreamErrorCooldown 决定该不该给账号上冷却。
func upstreamErrorCooldown(err error) bool {
	var ue *upstreamError
	if errors.As(err, &ue) {
		return ue.Cool
	}
	// 非分类错误默认冷却：网络层异常通常确实是账号侧的问题
	return true
}

// openedStream 是一条**已经建好、还没读**的上游流式响应。
//
// 拆出这一层是为了让等待室能复用同一条转发逻辑：等待期间反复调用
// openUpstreamStream 试探，一旦成功就把这个结构交给 forwardOpenedStream，
// 走的仍是与首次尝试完全相同的那段代码（计费、首字、断流判定都不分叉）。
type openedStream struct {
	resp          *http.Response
	upstreamProto string
	/*
		cancel 是这次上游请求的 context 取消函数。

		必须由**读完之后**那一方调用，不能在建连函数里 defer：上游请求的
		context 一旦取消，响应体立刻读不动了。早先在 openUpstreamStream
		里写 `defer cancel()`，函数一返回就把还在读的流掐断 ——
		现象是每次流式调用都在中途变成 `context canceled`，
		被记成「流式传输中断」并给账号上冷却（实测中把两个好账号打进了小黑屋）。
	*/
	cancel context.CancelFunc
}

/*
openUpstreamStream 建连并拿到 2xx 响应头，**不往客户端写任何字节**。

这一点是硬约束：只要还没写客户端，就还能换账号、还能进等待室；
一旦写了，状态码与响应头就定死了（HTTP 没有「先发 200 再改成 502」这回事）。
所以「建连」与「转发」必须分成两步，由调用方决定何时开流。

逐个候选端点尝试只覆盖「连接 + 拿到 2xx 响应头」这一段：
路径被拒（ModelProtocolUnsupported / 404）时换下一个端点，
其余失败（限流、鉴权、风控、网络）立刻返回。
*/
func openUpstreamStream(
	c *gin.Context,
	ch *services.UpstreamChannel,
	body []byte,
	model string,
) (*openedStream, error) {
	if len(ch.APIKeys) == 0 {
		return nil, errors.New("账号未配置上游密钥")
	}

	/*
		客户端按官方模型名调用，而上游只认它自己的叫法 —— 先解析出该账号
		实际该用的名字（与 forwardJSON 同一份逻辑，见 services.UpstreamModelFor）。
	*/
	upstreamModel := services.UpstreamModelFor(ch, model)
	if upstreamModel == "" {
		return nil, newUpstreamError(0, "账号「"+ch.Name+"」不支持模型 "+model, false)
	}

	/*
		上游协议可能按模型区分：聚合型上游常在同一 base_url 下
		让 Claude 走 /messages、Grok 走 /responses、GLM 走 /chat/completions。
		路径判错会直接被上游以 ModelProtocolUnsupported 拒掉。

		配置（model_paths）是首选依据；配置漏了或上游改了支持范围时，
		由 endpointCandidatesFor 自动试另外两个端点 —— 见 endpoint_fallback.go。
	*/
	preferredPath := upstreamPathForModel(ch, upstreamModel)
	// 固定协议渠道不参与端点协商（理由见 forwardJSON 处的说明）。
	candidates := []string{preferredPath}
	if !services.IsFixedProtocolChannel(ch) {
		candidates = endpointCandidatesFor(ch.ID, upstreamModel, preferredPath)
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 600*time.Second)
	/*
		context 的生命周期跨越「建连」与「转发」两个函数，所以这里用
		kept 标记所有权转移：失败路径（本函数返回 error）由 defer 回收，
		成功路径把 cancel 交给调用方，等 body 读完后再调用。

		直接写 `defer cancel()` 是**错误**的 —— 函数一返回就取消，
		还在读的响应体会立刻变成 `context canceled`（实测把两个好账号
		打进了小黑屋：每次流式调用都「传输中断」）。
	*/
	kept := false
	defer func() {
		if !kept {
			cancel()
		}
	}()

	var (
		lastStatus int
		lastRaw    string
	)
	for index, candidate := range candidates {
		proto := upstreamProtocol(candidate)

		// chat 协议的上游要强制带 usage，否则收不到 token 用量、无法精确计费。
		// 其他协议自带用量字段，塞 chat 专有参数会被上游 400 拒掉。
		upstreamBody := body
		if proto == "openai" {
			upstreamBody = forceStreamUsage(body)
		}
		converted, err := buildUpstreamBody(proto, upstreamBody, upstreamModel)
		if err != nil {
			return nil, newUpstreamError(0, "构造上游请求失败："+err.Error(), false)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost,
			strings.TrimRight(ch.BaseURL, "/")+candidate, bytes.NewReader(converted))
		if err != nil {
			return nil, newUpstreamError(0, err.Error(), false)
		}
		setUpstreamHeadersFor(req, ch.APIKeys[0], ch, proto)

		current, err := doUpstreamRequest(req, ch)
		if err != nil {
			// 连接层失败与端点无关（网络/代理/指纹），不换端点。
			return nil, upstreamRequestError(err)
		}

		if current.StatusCode >= 200 && current.StatusCode < 300 {
			if candidate != preferredPath {
				// 记住这个成功组合，后续请求直接命中，不再重复试错。
				rememberEndpointWinner(ch.ID, upstreamModel, preferredPath, candidate)
				log.Printf("[gateway] 账号「%s」模型 %s 首选端点 %s 被拒，改用 %s",
					ch.Name, upstreamModel, preferredPath, candidate)
			}
			kept = true
			return &openedStream{resp: current, upstreamProto: proto, cancel: cancel}, nil
		}

		raw, _ := io.ReadAll(io.LimitReader(current.Body, 8<<10))
		current.Body.Close()
		// 保留「第一个有意义的错误」（不能用最后那条 404 覆盖最初的原因）。
		if lastStatus == 0 || (lastStatus == http.StatusNotFound && current.StatusCode != http.StatusNotFound) {
			lastStatus, lastRaw = current.StatusCode, string(raw)
		}

		// 只有「路径/协议不被接受」才换下一个；其余（限流/鉴权/风控）立刻返回。
		if index == len(candidates)-1 || !shouldTryNextEndpoint(current.StatusCode, string(raw)) {
			break
		}
		log.Printf("[gateway] 账号「%s」端点 %s 拒绝模型 %s（HTTP %d），换下一个端点",
			ch.Name, candidate, upstreamModel, current.StatusCode)
		forgetEndpointWinner(ch.ID, upstreamModel, preferredPath)
	}

	message := fmt.Sprintf("上游返回 %d：%s", lastStatus, truncate(lastRaw, 300))
	if hint := friendlyUpstreamMessage(lastStatus, lastRaw); hint != "" {
		message = hint + "（上游原文：" + truncate(lastRaw, 200) + "）"
	}
	return nil, newUpstreamError(lastStatus, message, shouldCooldownOnStatus(lastStatus, lastRaw))
}

/*
forwardOpenedStream 从已打开的上游响应读到底、逐行翻译、写客户端，然后计费。

upstreamModel 在这里重新解析（纯内存查表，代价可忽略）：调用方拿到的
是同一条渠道，两次解析必然一致，少一层参数传递。

返回值 handled 表示「这一轮请求已经在往客户端写数据了」——
调用方据此决定还要不要继续换账号。
*/
func forwardOpenedStream(
	c *gin.Context,
	w *sseWriter,
	opened *openedStream,
	ch *services.UpstreamChannel,
	model string,
	token *apiToken,
	group *services.Group,
	start time.Time,
	translator streamTranslator,
	snapshot billingSnapshot,
) bool {
	if translator == nil {
		translator = &chatPassthrough{}
	}
	if opened == nil || opened.resp == nil {
		return false
	}
	resp := opened.resp
	upstreamProto := opened.upstreamProto
	// context 的所有权在这里：读完（或提前失败）才取消，
	// 详见 openedStream.cancel 的说明。
	if opened.cancel != nil {
		defer opened.cancel()
	}
	upstreamModel := services.UpstreamModelFor(ch, model)
	if upstreamModel == "" {
		resp.Body.Close()
		return false
	}
	defer resp.Body.Close()

	// 非 chat 协议的上游流先转回通用语，下游翻译器永远只面对一种输入格式。
	var upstreamConv upstreamStreamConverter
	if upstreamProto != "openai" {
		upstreamConv = newUpstreamStreamConverter(upstreamProto, upstreamModel)
	}

	reader := bufio.NewReaderSize(resp.Body, 64<<10)
	var usage upstreamUsage
	// capturedOutput 累积模型输出原文（正文 + 思考 + 工具调用）。
	// 只做记录，不参与转发 —— 解析失败就当这行没有输出。
	capturedOutput := &outputCapture{}

	// 首字耗时：上游第一个带内容增量的 chunk 到达的时刻。
	// 只认 delta（"content" / "reasoning_content" / "tool_calls" 都在 delta 里），
	// 不认 role 空壳与 usage 尾包 —— 那些不是「用户看到第一个字」。
	var firstTokenAt time.Time

	// firstTokenMs 返回从请求开始到首字的毫秒数；没等到首字则为 0。
	// 0 在 settle 里会保持为 0（而不是填成总耗时）——
	// 「这次没有产出内容」与「首字很慢」必须能区分。
	firstTokenMs := func() int {
		if firstTokenAt.IsZero() {
			return 0
		}
		return int(firstTokenAt.Sub(start).Milliseconds())
	}

	/*
		退出原因必须区分，否则「上游传到一半断开」会被记成一次成功调用，
		还会把账号的错误信息与冷却状态一起清掉 —— 坏账号因此藏起来看不见。

		三种退出：
		  - 客户端主动断开：请求已经服务过了（内容也产生过），按成功处理；
		  - 上游读取出错：内容不完整，是账号的问题，不能算成功；
		  - 正常读完：成功。
	*/
	var (
		readErr    error
		clientGone bool
	)

	/*
		客户端断开的判定。

		上游请求带的是 c.Request.Context()，客户端一断开（Codex 这类 CLI
		在切模型或用户按 Esc 时会直接掐连接），这个 context 立刻被取消，
		读到的是 context.Canceled —— 不是 io.EOF。

		早先只把「写响应失败」当成客户端断开，于是这种情况被记成
		「流式传输中断」，账号被标记失败并进入 60 秒冷却。
		只有一个账号的分组因此整组不可用，客户端看到「没有可用账号」后
		反复重连 —— 实测中 Codex 连着重试了 4 次，每次都白扣一次钱。

		判断依据用 context 的状态而不是错误值：错误可能是被包装过的
		（比如上游库把它包成 url.Error），用 errors.Is 逐个匹配容易漏。
	*/
	clientAborted := func() bool {
		return c.Request.Context().Err() != nil
	}

	// 写操作会从两个 goroutine 调用（转发循环与心跳），统一走 sseWriter
	// 串行化 —— gin 的 ResponseWriter 不是并发安全的。
	write := w.Write

	for {
		line, err := reader.ReadBytes('\n')

		// 上游的空行不转发：翻译器负责输出完整帧（含结尾空行），
		// 见 ensureSSEFrame 的说明。透传上游空行会让每个事件后多一个
		// 空行 —— 宽松的解析器会忽略，严格的解析器（如 Codex）会读坏。
		if len(bytes.TrimSpace(line)) == 0 {
			if err != nil {
				if !errors.Is(err, io.EOF) {
					readErr = err
				}
				break
			}
			continue
		}

		// 先把上游的一行转成通用语（chat-completions），再交给下游翻译器。
		normalized := line
		if upstreamConv != nil {
			normalized = upstreamConv.Convert(line)
		}
		/*
			SSE 分块里的 model 也换回客户端请求的名字。

			上游每个 chunk 都带自己的模型名（deepseek-v4.1-flash），
			而客户端请求的是官方名 —— 部分 SDK 会校验两者一致。
			与非流式路径同一口径（rewriteResponseModel）。
		*/
		if upstreamModel != model && len(normalized) > 0 {
			normalized = rewriteResponseModel(normalized, model)
		}

		// 到这里 normalized 已是「通用语」（chat-completions）的一行。
		if len(normalized) > 0 {
			// 输出原文快照：解析归一化后的增量，与转发行为完全无关。
			capturedOutput.addSSELine(normalized)
		}

		// usage：非 chat 协议的上游由转换器统一给出用量，
		// 它把各协议的字段都归到了 chat 的 usage 形状。
		if len(normalized) > 0 {
			if u := extractUsageFromSSE(normalized); u != nil {
				usage = *u
			}
			// 首字时刻：只认带内容增量的 chunk。
			// role 空壳（"content":""）、usage 尾包都不算首字。
			if firstTokenAt.IsZero() && hasContentDelta(normalized) {
				firstTokenAt = time.Now()
			}
		} else if upstreamConv != nil {
			if u := upstreamConv.Usage(); u.TotalTokens > 0 {
				usage = u
			}
		}

		if len(normalized) > 0 {
			sent := true
			for _, chunk := range translator.Translate(normalized) {
				if !write(chunk) {
					clientGone = true
					sent = false
					break
				}
			}
			if !sent {
				break
			}
		}
		if err == nil {
			continue
		}
		if err != nil {
			// io.EOF 是正常结束（上游关闭且内容已读完）。
			if !errors.Is(err, io.EOF) {
				readErr = err
			}
			break
		}
	}

	// 收尾事件（如 Anthropic 的 message_delta / message_stop）。
	// 客户端断开时不再写，但计费照常。
	if !clientGone && upstreamConv != nil {
		// 上游转换器在收尾时要补 [DONE]，否则下游会一直等流结束。
		// 用量也以它的统计为准 —— 它读的是上游协议里的真实字段。
		if u := upstreamConv.Usage(); u.TotalTokens > 0 {
			usage = u
		}
		if done := upstreamConv.Done(); len(done) > 0 {
			if !write(done) {
				clientGone = true
			}
		}
	}

	snapshot.OutputText = capturedOutput.text()

	logType := LogTypeCall
	errMsg := ""
	switch {
	case readErr != nil && !clientGone && !clientAborted():
		// 上游中途断开：内容不完整，算账号失败。
		// 已经知道的用量仍然结算 —— 不能因为日志类型是渠道失败就跳过扣费。
		services.MarkChannelFailure(ch.ID, readErr.Error())
		log.Printf("[gateway] 账号「%s」流式传输中断: %v", ch.Name, readErr)
		logType = LogTypeChannelFail
		errMsg = "流式传输中断：" + readErr.Error()
	case clientGone || clientAborted():
		// 客户端主动断开：这不是账号的问题，不能标记失败、更不能进冷却。
		// 已经产生的用量照常计费（用户确实消耗了 token），
		// 但账号状态保持干净 —— 否则「用户按一下 Esc」就能把自己唯一的账号打进小黑屋。
		log.Printf("[gateway] 客户端中断了流式请求（账号「%s」不受影响）", ch.Name)
	default:
		services.MarkChannelSuccess(ch.ID)
	}

	if err := settle(c, token, group, ch, model, usage, start, firstTokenMs(), logType, errMsg, snapshot); err != nil {
		log.Printf("[gateway] 结算失败: %v", err)
		// 内容已经交给客户端时留下预扣，避免这段输出变成免费的。
		// 还没产出内容则把预扣留给调用方退回。
		if !firstTokenAt.IsZero() || clientGone {
			clearBillingHold(c)
		}
		if !clientGone && translator != nil {
			msg := "结算失败，本次调用未完成"
			if errors.Is(err, errModelNotPriced) {
				msg = err.Error()
			}
			for _, chunk := range translator.FinishError(msg) {
				if !write(chunk) {
					break
				}
			}
		}
		return true
	}

	// 结算成功之后才发协议收尾。结算失败不能以正常结束收场。
	if !clientGone {
		for _, chunk := range translator.Finish(usage) {
			if !write(chunk) {
				break
			}
		}
	}
	return true
}

// extractUsageFromSSE 从一行 SSE 数据里提取 usage。
func extractUsageFromSSE(line []byte) *upstreamUsage {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return nil
	}

	var chunk struct {
		Usage *upstreamUsage `json:"usage"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return nil
	}
	return chunk.Usage
}

// hasContentDelta 判断一行 chat-completions SSE 是否携带「内容增量」。
//
// 首字耗时只认真正的增量：
//   - content 非空（普通正文）
//   - reasoning_content / reasoning 非空（思考型模型先出思考）
//   - tool_calls 非空（工具调用先出参数）
//
// role 空壳（首包 delta.role = assistant、content 为空）、
// 以及只带 usage 的尾包都不算 —— 用户此刻还没有看到任何内容。
func hasContentDelta(line []byte) bool {
	trimmed := bytes.TrimSpace(line)
	if !bytes.HasPrefix(trimmed, []byte("data:")) {
		return false
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return false
	}

	var chunk struct {
		Choices []struct {
			Delta struct {
				Content          string          `json:"content"`
				ReasoningContent string          `json:"reasoning_content"`
				Reasoning        string          `json:"reasoning"`
				ToolCalls        json.RawMessage `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return false
	}
	for _, choice := range chunk.Choices {
		d := choice.Delta
		// tool_calls 是数组，空数组的原始 JSON 是 "[]" —— 也要排除。
		if d.Content != "" || d.ReasoningContent != "" || d.Reasoning != "" {
			return true
		}
		if len(d.ToolCalls) > 2 && !bytes.Equal(bytes.TrimSpace(d.ToolCalls), []byte("[]")) {
			return true
		}
	}
	return false
}

// forceStreamUsage 往请求体里补上 stream_options.include_usage。
//
// 上游默认不在流式响应里带 usage，缺了它就收不到 token 用量，
// 流式调用将只能估费 —— 估算会有偏差，因此优先让上游直接给准确值。
func forceStreamUsage(body []byte) []byte {
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}

	opts, _ := payload["stream_options"].(map[string]any)
	if opts == nil {
		opts = map[string]any{}
	}
	opts["include_usage"] = true
	payload["stream_options"] = opts

	out, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return out
}

// ---------- Caller origin (usage display only) ----------

// Caller metadata describes the incoming request, not its model or upstream
// vendor. A UA can be spoofed/forwarded; these hints must never grant permission.
const maxCallerUserAgentBytes = 512

func sanitizeCallerUserAgent(raw string) string {
	var out strings.Builder
	for _, r := range raw {
		if r == utf8.RuneError || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			r = ' '
		}
		if out.Len()+utf8.RuneLen(r) > maxCallerUserAgentBytes {
			break
		}
		out.WriteRune(r)
	}
	return strings.TrimSpace(out.String())
}

type callerUserAgentPattern struct {
	id    string
	relay bool
	rx    *regexp.Regexp
}

func callerPattern(id, product string, relay bool) callerUserAgentPattern {
	// Require a product token, not a substring (e.g. not-oneapi is unknown).
	return callerUserAgentPattern{id, relay, regexp.MustCompile(`(?i)(?:^|[\s;(])(?:` + product + `)(?:[/ ]v?[0-9][a-z0-9_.+\-]*)?(?:$|[\s;)])`)}
}

var callerUserAgentPatterns = []callerUserAgentPattern{
	callerPattern("sub2api", `sub2api`, true),
	callerPattern("new-api", `new[-_ ]?api`, true),
	callerPattern("one-api", `one[-_ ]?api`, true),
	callerPattern("cpa", `cpa|cli[-_]?proxy[-_]?api(?:[-_ ]?plus)?`, true),
	callerPattern("litellm", `litellm(?:[-_ ]proxy)?`, true),
	callerPattern("one-hub", `one[-_ ]?hub`, true),
	callerPattern("codex", `codex(?:_cli_rs|[-_](?:cli|tui|desktop|vscode))?|codex [a-z][a-z0-9 .+\-]{0,48}`, false),
	callerPattern("claude-code", `claude(?:[-_](?:cli|code))?|claudecode`, false),
	callerPattern("opencode", `opencode`, false),
	callerPattern("zcode", `zcode`, false),
	callerPattern("qoder", `qoder(?:cli)?`, false),
	callerPattern("openclaw", `openclaw`, false),
	callerPattern("gemini-cli", `gemini[-_]?cli(?:-[a-z0-9-]+)?`, false),
	callerPattern("kilo", `kilocode|kilo[- ]?code|kilo`, false),
	callerPattern("roo-code", `roo[-_]?code`, false),
	callerPattern("copilot", `githubcopilotchat`, false),
	callerPattern("cursor", `cursor`, false),
	callerPattern("cline", `cline`, false),
	callerPattern("kiro", `kiro`, false),
	callerPattern("trae", `trae`, false),
	callerPattern("workbuddy", `workbuddy`, false),
	callerPattern("codebuddy", `codebuddy`, false),
	callerPattern("windsurf", `windsurf`, false),
	callerPattern("aider", `aider`, false),
	callerPattern("continue", `continue`, false),
	callerPattern("goose", `goose`, false),
}

func callerClientFromUserAgent(raw string) string {
	ua := sanitizeCallerUserAgent(raw)
	var clients, relays []string
	for _, p := range callerUserAgentPatterns {
		if p.rx.MatchString(ua) {
			if p.relay {
				relays = append(relays, p.id)
			} else {
				clients = append(clients, p.id)
			}
		}
	}
	// A relay token identifies the immediate caller even when it also reports a
	// terminal product. Multiple relay/product claims stay unknown, not guessed.
	if len(relays) == 1 {
		return relays[0]
	}
	if len(relays) == 0 && len(clients) == 1 {
		return clients[0]
	}
	// Go-http-client, generic SDKs, browser UAs and missing UAs cannot establish
	// a caller product. In particular, Go-http-client is NOT One API evidence.
	return ""
}

// ---------- 令牌鉴权 ----------

type apiToken struct {
	ID        int64
	UserID    int64
	APIKey    string
	Status    int
	Quota     int64
	Unlimited bool
	UsedQuota int64
	GroupName string
	Models    []string
	ExpiredAt *time.Time
	// 账号层面的额度与状态快照。
	// 额度用于请求前的余额门槛检查；状态用于「账号被禁用后密钥立刻失效」——
	// 只查密钥表是看不到账号状态的，禁用用户后他的 Key 还能继续调用。
	UserQuota     int64
	UserUsedQuota int64
	UserStatus    int

	// Request-scoped, untrusted display metadata only. Never used for access,
	// billing, channel selection or upstream headers.
	UserAgent    string
	CallerClient string
}

func authenticateAPIKey(c *gin.Context) (*apiToken, error) {
	raw := extractBearer(c)
	if raw == "" {
		return nil, errors.New("缺少 API Key，请在 Authorization 头里以 Bearer 形式提供")
	}
	if !auth.IsValidAPIKeyShape(raw) {
		return nil, errors.New("API Key 格式不正确")
	}

	var (
		t         apiToken
		modelsRaw sql.NullString
		expiredAt sql.NullTime
	)
	// 联表读出账号余额：只查令牌表拿不到余额，
	// 而余额不足时必须尽早拒绝，不能等事后扣费才发现。
	err := db.DB.QueryRow(
		`SELECT t.id, t.user_id, t.api_key, t.status, t.quota, t.unlimited_quota, t.used_quota,
		        t.group_name, t.models, t.expired_at, u.quota, u.used_quota, u.status
		 FROM tokens t
		 JOIN users u ON u.id = t.user_id
		 WHERE t.key_hash = ? OR (t.key_hash = '' AND t.api_key = ?)`,
		services.TokenKeyHash(raw), raw,
	).Scan(&t.ID, &t.UserID, &t.APIKey, &t.Status, &t.Quota, &t.Unlimited, &t.UsedQuota,
		&t.GroupName, &modelsRaw, &expiredAt, &t.UserQuota, &t.UserUsedQuota, &t.UserStatus)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("API Key 无效")
	}
	if err != nil {
		log.Printf("[gateway] 查询密钥失败: %v", err)
		return nil, errors.New("鉴权失败，请稍后重试")
	}

	// 结构里留明文，避免后续日志或比较误用密文。鉴权已经用摘要对上了。
	t.APIKey = raw
	t.UserAgent = sanitizeCallerUserAgent(c.GetHeader("User-Agent"))
	t.CallerClient = callerClientFromUserAgent(t.UserAgent)
	t.Models = splitModelList(modelsRaw.String)
	if expiredAt.Valid {
		ts := expiredAt.Time
		t.ExpiredAt = &ts
	}
	return &t, nil
}

func extractBearer(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	if after, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(after)
	}
	// 部分客户端用 x-api-key，OpenAI 兼容实现普遍支持这一种。
	return strings.TrimSpace(c.GetHeader("x-api-key"))
}

func checkTokenUsable(t *apiToken) error {
	// 账号状态先判：账号被禁用后，它名下的密钥必须一并失效，
	// 否则「禁用用户」只是挡住了后台登录，外部的 Key 仍能继续花钱。
	if t.UserStatus != 1 {
		return errors.New("账号已被禁用")
	}
	if t.Status != 1 {
		return errors.New("该密钥已被禁用")
	}
	if t.ExpiredAt != nil && t.ExpiredAt.Before(time.Now()) {
		return errors.New("该密钥已过期")
	}
	// 有限额度时才检查密钥余额；不限额度跟随账号余额。
	if !t.Unlimited && t.Quota >= 0 && t.UsedQuota >= t.Quota {
		return errors.New("该密钥的额度已用完")
	}

	/*
		账号余额门槛。

		只查密钥额度是不够的：密钥可能不限额度、或额度很宽裕，
		但账号本身已经用完 —— 那种情况下请求能通过鉴权，
		事后扣费却会失败，等于免费使用。

		这里用「余额 > 0」作为门槛而不是精确判断本次够不够：
		真实消费要等上游返回 usage 才知道，事前无法预知。
		余额为正时放行、扣费时再按实际用量扣，是后付费网关的常规做法。
	*/
	if t.UserQuota-t.UserUsedQuota <= 0 {
		return errors.New("账号余额不足，请充值后再调用")
	}
	return nil
}

func modelInList(list []string, model string) bool {
	target := strings.ToLower(strings.TrimSpace(model))
	for _, m := range list {
		pattern := strings.ToLower(strings.TrimSpace(m))
		if pattern == "" {
			continue
		}
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(target, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if target == pattern {
			return true
		}
	}
	return false
}

// ---------- 计费与日志 ----------

// logTextLimit 是日志文本列的字符上限（按 rune 计）。
// 一轮多步对话也只能保存有限原文：不截断的话，长上下文会把整行撑爆，
// 连带这条账单一起丢失。原文按 4000 字符留，够复核「当时问了什么、答了什么」。
const logTextLimit = 4000

// maxCapturedOutputChars 是流式输出在内存中累积的字符上限。
// 落库前还会裁到 logTextLimit，这里多留一倍余量即可，
// 同时避免超长回答把网关内存吃掉。
const maxCapturedOutputChars = 8000

// billingSnapshot 是一次调用的计费与内容快照，随 settle 一起写进日志。
//
// 三个模型名刻意分开记，事后对账时它们不一致往往就是
// 「为什么这次按这个价算」的答案：
//
//	RequestedModel 客户端请求的名字（如 claude-sonnet-4-5-20250929）
//	UpstreamModel  实际放进上游请求体的名字（别名映射后）
//	PricingModel   查价用的名字（本站按上游模型名定价）
//
// 文本字段都是可缺省的：拿不到就不记，绝不能因为记录快照影响计费。
type billingSnapshot struct {
	RequestedModel string
	UpstreamModel  string
	PricingModel   string
	InputText      string
	PromptText     string
	OutputText     string
}

// settle 结算一次调用：算费、扣额度、写日志。
//
// 即使上游没返回 usage（部分中转不返回），也要记一条日志 ——
// 用户需要看到「这次调用发生过」，否则会以为请求丢了。
//
// 失败也走这里（logType = LogTypeFailed，usage 为空）：失败不扣费，
// 但必须留下痕迹，否则成功率无从统计、用户报障无据可查。
//
// snap 是可选的计费/内容快照（模型名与文本原文）：旧调用方不传时
// 三个模型名退化为本次调用的模型名，文本为空 —— 行为与从前一致。
func settle(
	c *gin.Context,
	token *apiToken,
	group *services.Group,
	ch *services.UpstreamChannel,
	model string,
	usage upstreamUsage,
	start time.Time,
	firstTokenMs int,
	logType int,
	errMsg string,
	snap ...billingSnapshot,
) error {
	latency := int(time.Since(start).Milliseconds())

	// 首字耗时：流式由调用方测出；非流式（没有流可测）等价于总耗时。
	// 为 0 说明这次调用根本没有产出内容增量，保持 0 而不是填总耗时 ——
	// 「没有首字」和「首字很慢」是两件事。
	if firstTokenMs > latency {
		firstTokenMs = latency
	}

	var snapshot billingSnapshot
	if len(snap) > 0 {
		snapshot = snap[0]
	}
	if strings.TrimSpace(snapshot.RequestedModel) == "" {
		snapshot.RequestedModel = model
	}
	if strings.TrimSpace(snapshot.UpstreamModel) == "" {
		snapshot.UpstreamModel = model
	}
	/*
		查价必须用实际生效的模型名：与快照里记的 pricing_model 保持一致。

		再过一层「上游模型名 → 本站模型名」的映射：同一个模型在不同上游
		可能叫不同的名字（deepseek-v4.1-flash-sg），而定价是按本站名字配的。
		不映射就会查不到价、按 0 计费 —— 用户白用，站长白亏。
	*/
	pricingModel := strings.TrimSpace(snapshot.PricingModel)
	if pricingModel == "" {
		pricingModel = model
	}
	pricingModel = services.ResolveModelForPricing(pricingModel, services.HasPrice)

	cachedTokens := usage.cachedTokenCount()

	// group_rate 为 0 表示「未记录」；正常倍率 1 存 1。
	// group 为空只影响快照与倍率，按原价（ApplyGroupRate 对 0 回退 1）结算。
	groupRate := 0.0
	if group != nil {
		groupRate = group.Rate
	}

	/*
		账号级计费口径（context_billing）。

		input_only 表示「该账号按上下文长度计费、生成量不额外收费」——
		典型是订阅型账号：输入（含缓存）照常计价，输出 token 成本已含在
		订阅里。此时把计费用的 completion tokens 置 0，但**日志里仍然记录
		上游返回的真实 completion_tokens**：账单口径可以不同，
		用量事实必须如实记录，否则对账与用量统计会失真。
		input_only 之外（auto / full）口径与从前完全一致。
	*/
	billableCompletionTokens := usage.CompletionTokens
	inputOnlyBilling := ch != nil && ch.ContextBilling == "input_only"
	if inputOnlyBilling {
		billableCompletionTokens = 0
	}

	var (
		quota     int64
		baseQuota int64
		rawCost   float64
		price     services.ModelPrice
		priced    bool
	)
	if p, ok := services.LookupBillablePrice(pricingModel); ok {
		/*
			长上下文计价：按本次请求的输入 token 数选档。

			选中的档位会整次替代基础价（与上游「整次切档」的计费方式一致）。
			日志里固化的 input_price / output_price / cached_price 也必须是
			档位价 —— 否则事后按基础价复核会对不上账。
		*/
		priced = true
		if p.Model != "" {
			pricingModel = p.Model
		}
		price = services.PriceForTokens(p, usage.PromptTokens)
		unitsPerUnit := services.GetCurrency().UnitsPerUnit
		// raw_cost 是「未取整的额度表达式」的固化：与 CalcQuota / CostExpression
		// 同一套公式（缓存 token 只计一次），只是不做 ceil。
		rawCost = roundCostUnits(
			services.CostExpression(usage.PromptTokens, billableCompletionTokens, cachedTokens, price),
			unitsPerUnit,
		)
		// 传当前配置的「1 单位货币 = 多少额度单位」。
		// 传 0 会让 CalcQuota 回落到硬编码默认值，管理员改过换算比例后
		// 扣费就会与全站其它口径（注册赠送、前端金额展示）成倍不一致。
		baseQuota = services.CalcQuota(usage.PromptTokens, billableCompletionTokens, cachedTokens, price,
			unitsPerUnit)
		// 分组倍率在标准价之后再乘，这样「改了倍率」的效果和用户预期一致。
		quota = services.ApplyGroupRate(baseQuota, groupRate)
	}

	detail := fmt.Sprintf("账号=%s", ch.Name)
	// 计费口径说明：input_only 的账号输出不计费，日志必须能解释
	// 「为什么这次 completion tokens 不少、扣费却更便宜」——
	// 事后复核账单时，detail 是唯一能看到口径的地方。
	if inputOnlyBilling {
		detail += " 计费口径=只计输入"
	}
	if errMsg != "" {
		detail += " 错误=" + truncate(errMsg, 400)
	}

	inputText, inputCut := truncateLogText(snapshot.InputText, logTextLimit)
	promptText, promptCut := truncateLogText(snapshot.PromptText, logTextLimit)
	outputText, outputCut := truncateLogText(snapshot.OutputText, logTextLimit)

	/*
		扣费与写日志在同一个事务里。

		密钥与账号分开两次 UPDATE 时，一次成功一次失败会把账做歪，
		而失败只打日志、响应仍是成功补全。这里任一条件更新失败就整单回滚，
		调用方不得再返回成功的补全体。

		预扣（reserveBilling）已经占住一笔额度。本事务只补差额或退回多扣的部分，
		净额等于本次 quota。没有产生可计费用量的失败（额度本就是 0）会把预扣退回。

		流式中断只要已经知道 token / 费用，就按同样规则扣，不因为日志类型是
		渠道失败而跳过。没有用量的失败仍然不扣（避免把「没跑起来」收成 1 单位保底）。
	*/
	hold := billingHoldAmount(c)
	usageKnown := usage.PromptTokens > 0 || usage.CompletionTokens > 0 || cachedTokens > 0
	shouldCharge := priced && quota > 0 && (logType == LogTypeCall || usageKnown)

	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	accountedHold := false
	if shouldCharge {
		delta := quota - hold
		if delta > 0 {
			if err := chargeTokenExec(tx, token, delta); err != nil {
				return err
			}
			if err := chargeUserExec(tx, token.UserID, delta); err != nil {
				return err
			}
		} else if delta < 0 {
			if err := creditTokenExec(tx, token, -delta); err != nil {
				return err
			}
			if err := creditUserExec(tx, token.UserID, -delta); err != nil {
				return err
			}
		}
		accountedHold = true
	} else if hold > 0 {
		if err := creditTokenExec(tx, token, hold); err != nil {
			return err
		}
		if err := creditUserExec(tx, token.UserID, hold); err != nil {
			return err
		}
		accountedHold = true
	}

	/*
		只更新最近使用时间。

		额度已经由上面的条件更新扣过了 —— 这里若再写一次
		used_quota = used_quota + ?，用户会被收两倍费用。
		（这是实测发现的：应扣 2700 单位，实际扣了 5400。）
	*/
	if _, err := tx.Exec(
		"UPDATE tokens SET accessed_at = NOW() WHERE id = ?", token.ID,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO logs (user_id, token_id, channel_id, type, model,
		                   requested_model, upstream_model, pricing_model,
		                   prompt_tokens, completion_tokens, cached_tokens,
		                   input_price, output_price, cached_price,
		                   group_rate, base_quota, raw_cost,
		                   quota, latency_ms, first_token_ms, ip, detail,
		                   input_text, prompt_text, output_text, text_truncated,
		                   user_agent, caller_client)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		token.UserID, token.ID, ch.ID, logType, model,
		snapshot.RequestedModel, snapshot.UpstreamModel, pricingModel,
		usage.PromptTokens, usage.CompletionTokens, cachedTokens,
		price.InputPrice, price.OutputPrice, price.CachedPrice,
		groupRate, baseQuota, rawCost,
		quota, latency, firstTokenMs, c.ClientIP(), detail,
		logTextValue(inputText), logTextValue(promptText), logTextValue(outputText),
		inputCut || promptCut || outputCut,
		token.UserAgent, token.CallerClient,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	if accountedHold || hold == 0 {
		clearBillingHold(c)
	}
	if !priced && logType == LogTypeCall {
		return newUnpricedModelError(pricingModel)
	}
	return nil
}

// ---------- 调用内容快照 ----------

// chatContentText 从一段 chat-completions 的 content 里取出纯文本。
//
// content 既可能是字符串，也可能是分段数组：把其中的文本片段拼起来，
// 图片等没有文本的分段自然被忽略（Text 为空）。
func chatContentText(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err == nil {
			return text
		}
		return ""
	}

	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &parts); err != nil {
		return ""
	}
	var sb strings.Builder
	for _, part := range parts {
		if part.Text != "" {
			sb.WriteString(part.Text)
		}
	}
	return sb.String()
}

// extractInputText 取客户端本轮真正输入的内容：最后一条 role=user 的文本消息。
// 历史消息与工具结果都不是「用户输入」，不能拿来冒充。
func extractInputText(body []byte) string {
	var payload struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}

	last := ""
	for _, msg := range payload.Messages {
		if msg.Role != "user" {
			continue
		}
		if text := chatContentText(msg.Content); text != "" {
			last = text
		}
	}
	return last
}

// extractPromptText 把最终发给上游的 messages 拼成可读的上游上下文：
// 每段一条 "[role] content"，system 也在内 —— 计费按这段上下文算，
// 复核「为什么这么贵」看的就是它。工具调用跟在所属消息后。
func extractPromptText(body []byte) string {
	var payload struct {
		Messages []struct {
			Role      string          `json:"role"`
			Content   json.RawMessage `json:"content"`
			ToolCalls []struct {
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}

	var sb strings.Builder
	for _, msg := range payload.Messages {
		text := chatContentText(msg.Content)
		if text == "" && len(msg.ToolCalls) == 0 {
			continue
		}
		sb.WriteString("[" + msg.Role + "] " + text)
		for _, tc := range msg.ToolCalls {
			sb.WriteString("\n[tool_call] " + tc.Function.Name + "(" + tc.Function.Arguments + ")")
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

// outputTextFromChatResponse 从非流式 chat-completions 响应里取模型输出：
// 正文 + 思考，再接工具调用（name+args 各占一行）。
func outputTextFromChatResponse(raw []byte) string {
	var resp struct {
		Choices []struct {
			Message struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
				ToolCalls        []struct {
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil || len(resp.Choices) == 0 {
		return ""
	}

	msg := resp.Choices[0].Message
	var sb strings.Builder
	sb.WriteString(chatContentText(msg.Content))
	for _, text := range []string{chatContentText(msg.ReasoningContent), chatContentText(msg.Reasoning)} {
		if text == "" {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(text)
	}
	for _, tc := range msg.ToolCalls {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("[tool_call] " + tc.Function.Name + "(" + tc.Function.Arguments + ")")
	}
	return sb.String()
}

// outputCapture 累积一次调用的模型输出文本（正文 + 思考 + 工具调用）。
//
// 流式里所有内容都是碎片，这里按类别分别累积，最后按「正文、思考、
// 工具调用」的顺序拼成一段完整输出。超过 maxCapturedOutputChars 后
// 停止累积：日志只用前 4000 字符，没必要为超长回答持有整份原文。
type outputCapture struct {
	content   strings.Builder
	reasoning strings.Builder
	tools     map[int]*toolCallCapture
	toolOrder []int
	chars     int
}

// toolCallCapture 是一个工具调用的名字与参数（流式里两者都是碎片）。
type toolCallCapture struct {
	name string
	args strings.Builder
}

// appendLimited 往一个 builder 追加文本，总量到上限后停止。
func (o *outputCapture) appendLimited(dst *strings.Builder, text string) {
	if text == "" || o.chars >= maxCapturedOutputChars {
		return
	}
	runes := []rune(text)
	if room := maxCapturedOutputChars - o.chars; len(runes) > room {
		runes = runes[:room]
	}
	dst.WriteString(string(runes))
	o.chars += len(runes)
}

func (o *outputCapture) addContent(text string)   { o.appendLimited(&o.content, text) }
func (o *outputCapture) addReasoning(text string) { o.appendLimited(&o.reasoning, text) }

// addToolDelta 按 index 归并工具调用：同一个 index 的名字与参数碎片
// 要拼回一条完整的调用记录，否则参数会散成几十行。
func (o *outputCapture) addToolDelta(index int, name, arguments string) {
	if o.tools == nil {
		o.tools = map[int]*toolCallCapture{}
	}
	tc, ok := o.tools[index]
	if !ok {
		tc = &toolCallCapture{}
		o.tools[index] = tc
		o.toolOrder = append(o.toolOrder, index)
	}
	if name != "" {
		tc.name = name
	}
	if arguments != "" {
		o.appendLimited(&tc.args, arguments)
	}
}

// addSSELine 解析一行（已归一化为 chat-completions 的）上游 SSE。
// role 空壳、usage 尾包与 [DONE] 会被自然忽略：它们没有可记录的文本。
func (o *outputCapture) addSSELine(line []byte) {
	payload := sseData(line)
	if payload == nil {
		return
	}

	var chunk struct {
		Choices []struct {
			Delta struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
				ToolCalls        []struct {
					Index    int `json:"index"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return
	}

	for _, choice := range chunk.Choices {
		delta := choice.Delta
		o.addContent(chatContentText(delta.Content))
		o.addReasoning(chatContentText(delta.ReasoningContent))
		o.addReasoning(chatContentText(delta.Reasoning))
		for _, tc := range delta.ToolCalls {
			o.addToolDelta(tc.Index, tc.Function.Name, tc.Function.Arguments)
		}
	}
}

// text 拼出最终输出文本：正文、思考、工具调用依次排列。
func (o *outputCapture) text() string {
	var sb strings.Builder
	sb.WriteString(o.content.String())
	if reasoning := o.reasoning.String(); reasoning != "" {
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(reasoning)
	}
	for _, index := range o.toolOrder {
		tc := o.tools[index]
		if tc == nil || (tc.name == "" && tc.args.Len() == 0) {
			continue
		}
		if sb.Len() > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("[tool_call] " + tc.name + "(" + tc.args.String() + ")")
	}
	return sb.String()
}

// roundCostUnits 把额度表达式四舍五入到 6 位小数后存储：
// DECIMAL(20,6) 的精度足够复算，同时不把浮点尾巴写进日志。
func roundCostUnits(raw float64, unitsPerUnit int) float64 {
	return math.Round(raw*float64(unitsPerUnit)*1e6) / 1e6
}

// logTextValue 让空文本落库为 NULL：TEXT 列区分「没记录」与「记录到空」，
// 查询侧统一 COALESCE 成空串。
// logTextValue 决定文本列写什么。
//
// 空字符串照写，不转成 NULL：新写入的记录一律带「已采集」标记 ——
// 空串意味着「这次调用确实没有文本」，NULL 则代表「该记录根本没保存过」
// （只有本功能上线前的历史记录才是 NULL）。两者在页面上是不同的文案，
// 混在一起会把「未记录」说成「没有」。
func logTextValue(s string) any {
	return s
}

// truncateLogText 把文本裁到 limit 个字符并报告是否发生截断。
//
// 按 rune 计，不能把多字节字符切成两半（MySQL utf8mb4 会拒收非法字节）；
// 同时剔除 NUL —— 它不能安全进入 TEXT，也会把 JSON 体积撑大。
func truncateLogText(s string, limit int) (string, bool) {
	if s == "" {
		return "", false
	}
	s = strings.ToValidUTF8(s, "\uFFFD")
	if strings.ContainsRune(s, 0) {
		s = strings.ReplaceAll(s, "\x00", "")
	}
	if utf8.RuneCountInString(s) <= limit {
		return s, false
	}
	runes := []rune(s)
	return string(runes[:limit]), true
}

// logChannelAttemptFailure 记录一次账号尝试失败。
//
// 循环里每失败一次就写一条，带该账号的 id —— 这是账号成功率唯一的数据来源。
// 不写的话，「换了账号最后成功」的那些失败不会体现在任何账号身上，
// 账号健康度就永远显示 100%。
func logChannelAttemptFailure(
	token *apiToken,
	ch *services.UpstreamChannel,
	model string,
	latency time.Duration,
	errMsg string,
) {
	if token == nil || ch == nil {
		return
	}
	if _, err := db.DB.Exec(
		`INSERT INTO logs (user_id, token_id, channel_id, type, model,
		                   prompt_tokens, completion_tokens, cached_tokens,
		                   quota, latency_ms, ip, detail, user_agent, caller_client)
		 VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?, '', ?, ?, ?)`,
		token.UserID, token.ID, ch.ID, LogTypeChannelFail, model,
		int(latency.Milliseconds()), truncate("账号="+ch.Name+" 错误="+errMsg, 480),
		token.UserAgent, token.CallerClient,
	); err != nil {
		log.Printf("[gateway] 写入账号失败日志失败: %v", err)
	}
}

// logAllChannelsFailed 记录一次「所有账号都没成功」的调用。
//
// 与 settle 的区别：这里没有单一账号可归因（候选可能试过好几个），
// 也没有用量可结算，只留一条 type = LogTypeFailed 的记录，
// 让看板的成功率与失败数有数据来源。
//
// channel_id 记 0 而不是最后一个失败账号 —— 记上它会让该账号的
// 成功率被「别的账号导致的最终失败」污染。
func logAllChannelsFailed(
	c *gin.Context,
	token *apiToken,
	model string,
	start time.Time,
	errMsg string,
) {
	if token == nil {
		return
	}
	latency := int(time.Since(start).Milliseconds())

	if _, err := db.DB.Exec(
		`INSERT INTO logs (user_id, token_id, channel_id, type, model,
		                   prompt_tokens, completion_tokens, cached_tokens,
		                   quota, latency_ms, ip, detail, user_agent, caller_client)
		 VALUES (?, ?, 0, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)`,
		token.UserID, token.ID, LogTypeFailed, model,
		latency, c.ClientIP(), truncate(errMsg, 480), token.UserAgent, token.CallerClient,
	); err != nil {
		log.Printf("[gateway] 写入失败日志失败: %v", err)
	}
}

// 额度不足与未定价是结算失败的两种原因，调用方据此决定错误码。
var (
	errTokenQuota     = errors.New("密钥额度不足")
	errUserQuota      = errors.New("账号余额不足")
	errModelNotPriced = errors.New("model not priced")
)

type unpricedModelError struct{ Model string }

func newUnpricedModelError(model string) error {
	return unpricedModelError{Model: model}
}

func (e unpricedModelError) Error() string {
	return "模型「" + e.Model + "」尚未配置可用价格，无法调用。请先在后台「模型定价」中配置，未定价的模型不能按 0 元计费。"
}

func (e unpricedModelError) Unwrap() error { return errModelNotPriced }

// ctxBillingHoldKey 是本次请求已经预扣的额度（单位）。
const ctxBillingHoldKey = "ooapi.billing_hold"

func billingHoldAmount(c *gin.Context) int64 {
	if c == nil {
		return 0
	}
	v, ok := c.Get(ctxBillingHoldKey)
	if !ok {
		return 0
	}
	n, _ := v.(int64)
	if n < 0 {
		return 0
	}
	return n
}

func setBillingHold(c *gin.Context, amount int64) {
	if c == nil {
		return
	}
	if amount < 0 {
		amount = 0
	}
	c.Set(ctxBillingHoldKey, amount)
}

func clearBillingHold(c *gin.Context) { setBillingHold(c, 0) }

// reserveBilling 在上游调用前按估算输入成本预扣。
//
// 并发请求各自做条件更新，余额不够覆盖这笔预扣的后来者会失败，
// 不会都带着「余额 > 0」去上游把额度花穿。最终结算再把预扣调整成实际用量。
func reserveBilling(c *gin.Context, token *apiToken, group *services.Group, model string, body []byte) error {
	price, ok := services.LookupBillablePrice(model)
	if !ok {
		return newUnpricedModelError(model)
	}
	amount := holdQuota(group, price, body)
	if amount < 1 {
		amount = 1
	}
	if err := debitQuota(token, amount); err != nil {
		return err
	}
	setBillingHold(c, amount)
	return nil
}

// holdQuota 用请求正文估算的输入 token 预扣一笔至少为 1 的额度。
func holdQuota(group *services.Group, price services.ModelPrice, body []byte) int64 {
	prompt := estimateTokens(extractPromptText(body))
	if prompt < 1 {
		prompt = estimateTokens(string(body))
	}
	units := services.GetCurrency().UnitsPerUnit
	base := services.CalcQuota(prompt, 0, 0, price, units)
	rate := 0.0
	if group != nil {
		rate = group.Rate
	}
	return services.ApplyGroupRate(base, rate)
}

// releaseBillingHold 退回尚未被结算吃掉的预扣。调用失败且没有交付结果时使用。
func releaseBillingHold(c *gin.Context, token *apiToken) {
	amount := billingHoldAmount(c)
	clearBillingHold(c)
	if amount <= 0 || token == nil {
		return
	}
	if err := creditQuota(token, amount); err != nil {
		log.Printf("[gateway] 退回预扣额度失败: %v", err)
	}
}

func debitQuota(token *apiToken, amount int64) error {
	if amount <= 0 {
		return nil
	}
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := chargeTokenExec(tx, token, amount); err != nil {
		return err
	}
	if err := chargeUserExec(tx, token.UserID, amount); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

func creditQuota(token *apiToken, amount int64) error {
	if amount <= 0 {
		return nil
	}
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := creditTokenExec(tx, token, amount); err != nil {
		return err
	}
	if err := creditUserExec(tx, token.UserID, amount); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// queryExec 让扣费语句既能跑在连接上，也能跑在事务里。
type queryExec interface {
	Exec(query string, args ...any) (sql.Result, error)
}

// chargeTokenExec 扣减密钥额度。
//
// 条件更新：`used_quota + 本次 <= quota`。
// 这样并发请求不会把额度扣成负数 —— 数据库层面保证原子性，
// 不需要额外的锁。
func chargeTokenExec(ex queryExec, t *apiToken, quota int64) error {
	if quota <= 0 {
		return nil
	}
	/*
		不限额度也要照常累加 used_quota。

		早先这里有一句 `if t.Unlimited { return nil }` 直接跳过，
		结果是：账号的 used_quota 在涨，而密钥的 used_quota 恒为 0。
		后果不止是「密钥页的已用永远显示 0」—— 对账接口拿
		「账号已用 - 现存密钥已用之和」当「已删除密钥花掉的钱」，
		于是没删过任何密钥的用户也会看到一条「另有已删除密钥花掉 X」，
		把真实账目掩盖成噪音。

		下面的 SQL 已经用 (unlimited_quota = 1 OR ...) 处理了额度上限，
		不限额度时它天然不会拦住写入，因此不需要在这里提前返回。
	*/
	res, err := ex.Exec(
		`UPDATE tokens SET used_quota = used_quota + ?
		 WHERE id = ? AND (unlimited_quota = 1 OR used_quota + ? <= quota)`,
		quota, t.ID, quota,
	)
	if err != nil {
		return err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return errTokenQuota
	}
	return nil
}

// chargeUserExec 扣减账号额度。
func chargeUserExec(ex queryExec, userID, quota int64) error {
	if quota <= 0 {
		return nil
	}
	res, err := ex.Exec(
		`UPDATE users SET used_quota = used_quota + ?
		 WHERE id = ? AND used_quota + ? <= quota`,
		quota, userID, quota,
	)
	if err != nil {
		return err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return errUserQuota
	}
	return nil
}

func creditTokenExec(ex queryExec, t *apiToken, quota int64) error {
	if quota <= 0 {
		return nil
	}
	res, err := ex.Exec(
		`UPDATE tokens SET used_quota = used_quota - ? WHERE id = ? AND used_quota >= ?`,
		quota, t.ID, quota,
	)
	if err != nil {
		return err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return errTokenQuota
	}
	return nil
}

func creditUserExec(ex queryExec, userID, quota int64) error {
	if quota <= 0 {
		return nil
	}
	res, err := ex.Exec(
		`UPDATE users SET used_quota = used_quota - ? WHERE id = ? AND used_quota >= ?`,
		quota, userID, quota,
	)
	if err != nil {
		return err
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		return errUserQuota
	}
	return nil
}

// ---------- 辅助 ----------

var upstreamClient = &http.Client{
	// 不设整体超时：流式响应可能持续很久。
	// 超时由每个请求的 context 控制（600 秒）。
	Timeout:       0,
	CheckRedirect: netguard.CheckRedirect,
	Transport:     netguard.PublicTransport(),
}

func setUpstreamHeaders(req *http.Request, apiKey string, ch *services.UpstreamChannel) {
	setUpstreamHeadersFor(req, apiKey, ch, "openai")
}

// setUpstreamHeadersFor 按上游协议设置请求头。
func setUpstreamHeadersFor(req *http.Request, apiKey string, ch *services.UpstreamChannel, protocol string) {
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// 鉴权方式按协议区分：Anthropic 系用 x-api-key，OpenAI 系用 Bearer
	applyUpstreamAuth(req, protocol, apiKey)

	// 账号自定义头。放在默认头之后设置，让管理员能覆盖它们 ——
	// 极少数上游的鉴权方式不是 Bearer，硬顶着默认值会连不通。
	if ch == nil {
		return
	}
	session := ""
	for _, h := range ch.Headers {
		value := h.Value
		if strings.Contains(value, sessionPlaceholder) {
			// 懒生成：只有真用到 {{session}} 的账号才需要这个随机 ID，
			// 同一个请求里的多个头共用同一个会话值。
			if session == "" {
				session = newSessionID()
			}
			value = strings.ReplaceAll(value, sessionPlaceholder, session)
		}
		req.Header.Set(h.Key, value)
	}
}

// sessionPlaceholder 是账号头里代表「每次请求随机的会话 ID」的占位符。
//
// 存在的理由：OpenCode Go 要求每个请求带 x-opencode-session，
// 缺失时直接返回 MissingSessionID 拒绝服务。它希望那是「稳定的会话标识」——
// 对网关来说，一次上游请求就是一次会话，因此每次生成一个新 ID。
const sessionPlaceholder = "{{session}}"

// newSessionID 生成一个随机会话 ID。
// 不追求密码学强度，只要在会话之间不重复即可。
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// 取不到随机数时退回时间戳：ID 重复只会让上游的路由不那么理想，
		// 不该因为随机源故障让整个请求失败。
		return fmt.Sprintf("ses%d", time.Now().UnixNano())
	}
	return "ses_" + hex.EncodeToString(b[:])
}
