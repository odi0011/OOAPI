package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/netguard"
	"ooapi/internal/services"
)

// errChannelRateLimited 表示账号在 SelectChannels 之后被并发请求抢先占满
// 限流名额（检查与发车之间的竞态）。
// 这不是账号故障：不标失败、不冷却，直接换下一个候选账号。
var errChannelRateLimited = errors.New("账号已达速率上限")

/*
账号级出口代理（proxy_url）。

每个不同代理地址只建一条传输链（缓存复用）：代理地址在账号之间通常
只有少数几个取值（同一台代理服务多个账号），按 URL 复用客户端才能
让连接池真正起作用；逐请求新建传输会让连接永远无法复用。

传输链的构成与共享客户端一致：底部是「带 Proxy 的 DefaultTransport 克隆」，
上面按 init 顺序叠回设备授权装饰器（cline → grok → kiro → workbuddy）——
否则任一厂商的渠道一旦配了代理，协议改写会被跳过，
请求会带着内部凭据标识直接打到官方主机上、必然失败。

安全：代理地址在「使用前」必过 netguard.AssertPublicURL ——
它与账号 base_url 面对同一类 SSRF 风险（把流量导向内网/云元数据端点）。
校验失败返回 ErrProxyRejected，调用方按账号级失败处理：
跳过该账号换下一个候选，绝不静默回退直连（静默回退等于泄露真实出口 IP，
且管理员会以为代理在生效）。
*/
var (
	// ErrProxyRejected 表示该账号的代理不可用（配置不合法或校验不通过）。
	ErrProxyRejected = errors.New("账号代理不可用")

	proxyTransportMu sync.Mutex
	proxyTransports  = map[string]http.RoundTripper{}
)

// proxyTransportFor 返回该代理 URL 对应的 RoundTripper；空地址返回 nil（直连）。
func proxyTransportFor(proxyURL string) (http.RoundTripper, error) {
	raw := strings.TrimSpace(proxyURL)
	if raw == "" {
		return nil, nil
	}

	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.Scheme == "" {
		return nil, fmt.Errorf("%w：地址格式不正确", ErrProxyRejected)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks5":
	default:
		return nil, fmt.Errorf("%w：只支持 http / https / socks5，收到 %q", ErrProxyRejected, parsed.Scheme)
	}

	/*
		使用前必过 netguard。

		校验放在缓存查找**之前**：带凭据或指向内网的地址连缓存键
		都不会建立（也就永不缓存），且每次调用都会重新校验 ——
		管理员把地址改对后立即生效，不存在「旧结果继续命中」的窗口。
		netguard 自身按主机缓存解析结果，命中时只是一次 map 查询，
		每请求校验的成本可以忽略。
	*/
	if _, err := netguard.AssertPublicURL(raw); err != nil {
		return nil, fmt.Errorf("%w：%v", ErrProxyRejected, err)
	}

	// 规范化后的地址当缓存键：大小写/空白差异不该产生两份连接池。
	key := strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host)

	proxyTransportMu.Lock()
	if rt, ok := proxyTransports[key]; ok {
		proxyTransportMu.Unlock()
		return rt, nil
	}
	proxyTransportMu.Unlock()

	// 从默认传输克隆：超时/TLS/连接池参数与直连完全一致，
	// 只多一个 Proxy 差异 —— 否则「代理账号」会被额外限速。
	var dial http.RoundTripper
	if base, ok := http.DefaultTransport.(*http.Transport); ok && base != nil {
		clone := base.Clone()
		clone.Proxy = http.ProxyURL(parsed)
		clone.DialContext = netguard.DialPublic
		dial = clone
	} else {
		dial = &http.Transport{Proxy: http.ProxyURL(parsed), DialContext: netguard.DialPublic}
	}

	/*
		复刻全部上游装饰器链。顺序必须与各 transport 的 init 一致
		（初始化按文件名字典序：antigravity → claude → cline → codex →
		grok → kiro → workbuddy，每个新装饰器都包住「当前」transport，
		因此最外层是 workbuddy）。

		漏掉任何一层，对应厂商的渠道一旦配了代理，请求会带着内部凭据标识
		直接打到官方主机上、必然失败 —— 而且只在「配了代理」的账号上复现，
		极难排查。
	*/
	var rt http.RoundTripper = dial
	rt = &antigravityTransport{base: rt}
	rt = &claudeOAuthTransport{base: rt}
	rt = &clineTransport{base: rt}
	rt = &codexTransport{base: rt}
	rt = &grokTransport{base: rt}
	rt = &kiroTransport{base: rt}
	rt = &workbuddyTransport{base: rt}

	proxyTransportMu.Lock()
	// 防御性上限：代理地址由管理员配置，正常数量极少；
	// 超过上限直接清空重建，避免异常配置把这张表撑大。
	if len(proxyTransports) >= maxProxyTransports {
		proxyTransports = map[string]http.RoundTripper{}
	}
	proxyTransports[key] = rt
	proxyTransportMu.Unlock()
	return rt, nil
}

// maxProxyTransports 是代理传输缓存的上限（正常远达不到）。
const maxProxyTransports = 128

// doChannelRequest 按代理地址选择出口并执行请求。
//
// fallback 是未配代理时使用的共享客户端（正式转发用 upstreamClient，
// 连通性测试与拉模型用 probeClient）—— 空代理时行为与从前完全一致。
func doChannelRequest(req *http.Request, proxyURL string, fallback *http.Client) (*http.Response, error) {
	rt, err := proxyTransportFor(proxyURL)
	if err != nil {
		return nil, err
	}
	if err := rejectPrivateUpstream(req); err != nil {
		return nil, err
	}
	if rt == nil {
		return fallback.Do(req)
	}
	// Timeout 0：流式响应可能持续很久，超时统一由请求 context 控制。
	// 重定向单独再验：不能跟着 302 走进内网或云元数据地址。
	return (&http.Client{Transport: rt, CheckRedirect: netguard.CheckRedirect}).Do(req)
}

// doUpstreamRequest 按账号的 proxy_url 与 tls_fingerprint 选择出口并执行请求。
//
// 两者可以叠加：先按指纹建连（握手形状），代理则决定连到哪里 ——
// 走代理时 TLS 由代理隧道的对端协商，因此指纹只对直连生效
// （这是 TLS 的固有限制，不是实现取舍；注释里说明以免误解）。
//
// 代理不可用时返回 *upstreamError（账号级失败）：调用方会把该账号
// 标记失败并换下一个候选，不会退化成直连。ch 为 nil 或两项都没配时
// 走共享的 upstreamClient，行为与从前完全一致。
func doUpstreamRequest(req *http.Request, ch *services.UpstreamChannel) (*http.Response, error) {
	if err := rejectPrivateUpstream(req); err != nil {
		return nil, newUpstreamError(0, "上游地址不可用："+err.Error(), true)
	}
	proxyURL := ""
	fingerprint := services.TLSProfileOff
	if ch != nil {
		proxyURL = ch.ProxyURL
		profile, err := services.ParseTLSProfile(ch.TLSFingerprint)
		if err != nil {
			// 配置写错了就如实报错，不静默降级成「没有指纹」——
			// 否则管理员以为生效了，实际一直在裸连。
			return nil, newUpstreamError(0, "TLS 指纹配置有误："+err.Error(), true)
		}
		fingerprint = profile
	}

	// 代理优先：代理存在时由代理侧完成对外 TLS，本地指纹无从施加。
	if strings.TrimSpace(proxyURL) != "" {
		resp, err := doChannelRequest(req, proxyURL, upstreamClient)
		if err != nil && errors.Is(err, ErrProxyRejected) {
			return nil, newUpstreamError(0, err.Error(), true)
		}
		return resp, err
	}

	if rt := services.TLSFingerprintTransport(fingerprint); rt != nil {
		// Timeout 0：流式响应可能持续很久，超时统一由请求 context 控制。
		return (&http.Client{Transport: rt, CheckRedirect: netguard.CheckRedirect}).Do(req)
	}
	return upstreamClient.Do(req)
}

// upstreamRequestError 把 doUpstreamRequest 的返回错误整理成上游错误。
// 代理被拒等已分类的错误原样传递，其余（网络层）保持原有文案与冷却策略。
func upstreamRequestError(err error) *upstreamError {
	var ue *upstreamError
	if errors.As(err, &ue) {
		return ue
	}
	return newUpstreamError(0, "无法连接上游："+err.Error(), true)
}

// rejectPrivateUpstream 在真正拨号前再跑一次 netguard。
// 账号地址在保存时验过，但转发当下 DNS 可能已经指向内网。
func rejectPrivateUpstream(req *http.Request) error {
	if req == nil || req.URL == nil || req.URL.Host == "" {
		return nil
	}
	_, err := netguard.AssertPublicURL(req.URL.String())
	return err
}

/*
协议适配层。

网关对外要同时讲三种协议，因为主流 CLI 各自只认一种：

	/v1/chat/completions  OpenAI Chat Completions   最通用，SDK 与脚本都用
	/v1/responses         OpenAI Responses           Codex CLI 只认这个
	/v1/messages          Anthropic Messages         Claude Code 只认这个

三者只有「请求与响应的外壳」不同，内部链路完全一致：
鉴权 → 额度 → 分组白名单 → 账号调度 → 上游转发 → 计费 → 记日志。

所以把内部链路抽到这里，协议适配器只负责翻译外壳。
这样计费与调度全站只有一份实现 —— 三条路径各写一遍的结果，
必然是其中一条忘了扣费，而且很难被发现。
*/

// errWriterFunc 决定错误响应的形状。
// 三种协议的错误格式互不兼容，客户端 SDK 又都按各自格式解析，
// 所以由协议适配器决定怎么写，核心链路只管把错误交出去。
type errWriterFunc func(c *gin.Context, status int, message, code string)

// writeOpenAIError 按 OpenAI 的错误格式返回。
// chat/completions 与 responses 两种协议共用这个形状 ——
// 它们的 error 对象结构本来就一致，SDK 也按同一套解析。
func writeOpenAIError(c *gin.Context, status int, message, code string) {
	c.JSON(status, gin.H{
		"error": gin.H{
			"message": message,
			"type":    "invalid_request_error",
			"code":    code,
		},
	})
}

// writeBillingError 把结算 / 预扣失败写成对应协议的错误，且不附带成功补全体。
func writeBillingError(c *gin.Context, writeErr errWriterFunc, err error) {
	switch {
	case errors.Is(err, errModelNotPriced):
		writeErr(c, http.StatusForbidden, err.Error(), "model_not_priced")
	case errors.Is(err, errTokenQuota), errors.Is(err, errUserQuota):
		writeErr(c, http.StatusForbidden, "账号余额不足，无法完成本次调用", "insufficient_quota")
	default:
		writeErr(c, http.StatusInternalServerError, "结算失败，本次调用未完成", "billing_failed")
	}
}

// writeAnthropicError 按 Anthropic 的错误格式返回。
// Claude Code 读的是 error.type / error.message 这一层。
func writeAnthropicError(c *gin.Context, status int, message, code string) {
	// Anthropic 把「服务端错误」与「请求错误」分成两个 type，
	// 客户端据此决定要不要重试。
	errType := "invalid_request_error"
	if status >= 500 {
		errType = "api_error"
	}
	c.JSON(status, gin.H{
		"type": "error",
		"error": gin.H{
			"type":    errType,
			"message": message,
		},
		// 网关自己的错误码放在这里，方便对照后台日志
		"code": code,
	})
}

// upstreamCall 是一次上游调用的结果。
type upstreamCall struct {
	Body    []byte
	Usage   upstreamUsage
	Channel *services.UpstreamChannel
	Group   *services.Group
}

// ctxRequestedModelKey 是「客户端原始请求的模型名」在 gin context 里的键。
//
// 协议适配层写入：Anthropic 路径会做别名映射（claude-sonnet-4-5-* →
// 本站配置的模型名），映射后模型名会作为 model 一路传到结算，
// 原始名字就只剩这里能拿到。计费快照要把「请求的」与「实际用的」
// 两个名字都写进日志，事后才能对账。
const ctxRequestedModelKey = "ooapi.requested_model"

// billingSnapshotFor 组装计费快照的公共部分：三个模型名与输入/上下文文本。
// 输出文本由调用方在拿到模型输出后补上（见 outputTextFromChatResponse
// 与 outputCapture）。
func billingSnapshotFor(c *gin.Context, model string, body []byte) billingSnapshot {
	snapshot := billingSnapshot{
		RequestedModel: model,
		UpstreamModel:  model,
		PricingModel:   model,
		InputText:      extractInputText(body),
		PromptText:     extractPromptText(body),
	}
	if v, ok := c.Get(ctxRequestedModelKey); ok {
		if requested, ok := v.(string); ok && strings.TrimSpace(requested) != "" {
			snapshot.RequestedModel = requested
		}
	}
	return snapshot
}

// checkAccess 完成鉴权之后的各项校验，返回该请求应使用的分组。
//
// 校验失败时已经把错误响应写好了，调用方直接 return 即可。
func checkAccess(c *gin.Context, token *apiToken, model string, writeErr errWriterFunc) (*services.Group, bool) {
	if err := checkTokenUsable(token); err != nil {
		writeErr(c, http.StatusForbidden, err.Error(), "insufficient_quota")
		return nil, false
	}

	group, err := services.GroupByName(token.GroupName)
	if err != nil {
		writeErr(c, http.StatusForbidden,
			"密钥绑定的分组不存在："+token.GroupName+"，请联系管理员", "invalid_group")
		return nil, false
	}

	/*
		未绑定真实模型的别名一律拒绝。

		上游自造的别名（default-model / fast-model / auto …）既看不懂、
		又没有对应定价 —— 放行等于按 0 计费（免费）。已有账号里可能就存着
		这类名字（本规则生效之前配的），所以不能只在保存时拦，
		请求入口也要拦，否则它们会一直免费用下去。

		报错必须点名「怎么办」：只说「模型不允许」会让人以为是权限问题。
	*/
	if services.AliasModelHint(model) {
		writeErr(c, http.StatusForbidden,
			"模型「"+model+"」尚未绑定真实模型，无法调用。请在后台「全部模型」页把它绑定到对应的真实模型（会一并配好价格与参数）。",
			"model_not_bound")
		return nil, false
	}

	// 官方模型没有可用定价时必须拒绝。放行会在结算时按 0 计费。
	if _, ok := services.LookupBillablePrice(model); !ok {
		writeErr(c, http.StatusForbidden, newUnpricedModelError(model).Error(), "model_not_priced")
		return nil, false
	}

	// 模型白名单：令牌级与分组级都要满足
	if len(token.Models) > 0 && !modelInList(token.Models, model) {
		writeErr(c, http.StatusForbidden,
			"当前密钥不允许调用模型 "+model, "model_not_allowed")
		return nil, false
	}
	if !group.ModelAllowed(model) {
		writeErr(c, http.StatusForbidden,
			"分组「"+group.Name+"」不允许调用模型 "+model, "model_not_allowed")
		return nil, false
	}
	return group, true
}

// callUpstream 非流式：选账号 → 转发 → 计费 → 记日志，返回上游原始响应。
//
// 换账号重试的逻辑放在这里：三种协议都需要它，
// 各写一遍迟早会出现「某个协议不重试」的差异。
func callUpstream(
	ctx context.Context,
	c *gin.Context,
	token *apiToken,
	group *services.Group,
	model string,
	body []byte,
	start time.Time,
	writeErr errWriterFunc,
) (*upstreamCall, bool) {
	/*
		先剥掉等待期间的提示语（见 stripHoldNotices）。

		放在这里而不是各协议入口：三条入口（chat / messages / responses）
		最终都汇到这条链路，剥一次就全覆盖。顺带保证计费快照里记录的
		输入/提示原文也不含提示语 —— 日志里出现的应当只有用户真实说的话。
	*/
	body = stripHoldNotices(body)

	if err := reserveBilling(c, token, group, model, body); err != nil {
		writeBillingError(c, writeErr, err)
		return nil, false
	}
	defer releaseBillingHold(c, token)

	excluded := map[int64]struct{}{}
	var lastErr error

	// 调用方标识只用于账号的 require_caller 白名单过滤：
	// 非空白名单的账号只对该调用方开放，这是限制型访问控制。
	callerClient := ""
	if token != nil {
		callerClient = token.CallerClient
	}

	for attempt := 0; attempt < maxChannelAttempts; attempt++ {
		channels, err := services.SelectChannels(model, group.Name, callerClient, excluded)
		if err != nil {
			if lastErr == nil {
				lastErr = errors.New("没有可用账号，请在后台检查账号状态与模型配置")
			}
			break
		}

		ch := channels[0]
		excluded[ch.ID] = struct{}{}

		/*
			账号级限流占位。

			SelectChannels 已用 Allow 过滤过一次，但那只是「检查」；
			两次检查之间可能有并发请求抢走名额（竞态）。
			TryAcquire 原子地完成「检查 + 登记发车」，这里是最终裁决点：
			失败说明该账号此刻确实忙，跳过它换下一个候选，而不是让请求失败。
			Release 用 defer 保证在转发返回（含 panic 路径）后一定归还名额。
		*/
		if !services.RateLimitAcquire(ch) {
			lastErr = fmt.Errorf("%w：账号「%s」", errChannelRateLimited, ch.Name)
			log.Printf("[gateway] 账号「%s」已达速率上限，跳过本次尝试", ch.Name)
			continue
		}

		respBody, usage, err := func() ([]byte, upstreamUsage, error) {
			defer services.RateLimitRelease(ch)
			return forwardJSON(ctx, ch, body, model)
		}()
		if err != nil {
			lastErr = err
			// 只有「账号不健康」的失败才上冷却。
			// 4xx 那种请求级错误（模型不支持、参数不对）只记一笔，
			// 否则一次错误的请求就能把好账号踢出调度 60 秒。
			services.MarkChannelFailureWithCooldown(ch.ID, err.Error(), upstreamErrorCooldown(err))
			logChannelAttemptFailure(token, ch, model, time.Since(start), err.Error())
			log.Printf("[gateway] 账号「%s」转发失败: %v", ch.Name, err)

			// 请求本身有问题时换账号也没用，直接放弃重试，
			// 把上游的原始错误如实交给用户。
			if isClientError(err) {
				break
			}
			continue
		}

		services.MarkChannelSuccess(ch.ID)
		/*
			回显客户端请求的模型名。

			上游返回的是它自己的叫法（deepseek-v4.1-flash），而客户端请求的是
			官方名（deepseek-flash）。部分 SDK / Agent 会校验返回的 model 与请求
			是否一致，不一致就报错；用户看到的也应当是自己使用的那个名字。
			上游真实用的名字记在日志的 upstream_model 字段里，排查有据可查。
		*/
		respBody = rewriteResponseModel(respBody, model)
		// 非流式没有可观测的「首字」：响应体一次性到达，
		// 无法区分「上游想了很久」与「传输很慢」。首字记 0（未记录），
		// 前端显示「—」—— 把总耗时冒充首字会误导排障。
		snapshot := billingSnapshotFor(c, model, body)
		snapshot.OutputText = outputTextFromChatResponse(respBody)
		if err := settle(c, token, group, ch, model, usage, start, 0, LogTypeCall, "", snapshot); err != nil {
			log.Printf("[gateway] 结算失败: %v", err)
			writeBillingError(c, writeErr, err)
			return nil, false
		}
		return &upstreamCall{Body: respBody, Usage: usage, Channel: ch, Group: group}, true
	}

	/*
		所有候选账号都没能建起连接。

		非流式没有「发进度」的通道（连接上最终只能回一个响应），用户那边
		只能看到「这次有点慢」，所以不做 50 分钟的长等待，而是**静默重试**：
		账号冷却几十秒到几分钟再恢复的情况很常见，等一等就能拿到真答案，
		比回一个 502 好得多（脚本/SDK 拿到 502 往往直接判失败退出）。

		上限取 jsonHoldMaxWait 而不是 holdMaxWait：客户端自己的读超时
		（主流 SDK 默认 600s，但不少客户端设得更短）会先炸，等太久等于白等。
	*/
	if shouldHoldFor(lastErr, model, group.Name, callerClient) {
		log.Printf("[gateway] 模型 %s 无可用账号（%s），非流式静默等待：%v",
			model, holdSituation(model, group.Name, callerClient), lastErr)
		if body, usage, ch, ok := retrySilently(ctx, c, token, group, model, body, start, callerClient, lastErr); ok {
			snapshot := billingSnapshotFor(c, model, body)
			snapshot.OutputText = outputTextFromChatResponse(body)
			if err := settle(c, token, group, ch, model, usage, start, 0, LogTypeCall, "", snapshot); err != nil {
				log.Printf("[gateway] 结算失败: %v", err)
				writeBillingError(c, writeErr, err)
				return nil, false
			}
			return &upstreamCall{Body: body, Usage: usage, Channel: ch, Group: group}, true
		}
	}

	msg := "所有可用账号均调用失败"
	if lastErr != nil {
		msg += "：" + lastErr.Error()
	}
	logAllChannelsFailed(c, token, model, start, msg)

	// 上游是 4xx（请求本身有问题）时透传它的状态码。
	// 统一报 502 会让用户以为网关挂了，实际上是自己请求里的问题。
	status := http.StatusBadGateway
	var ue *upstreamError
	if errors.As(lastErr, &ue) && ue.Status >= 400 && ue.Status < 500 {
		status = ue.Status
	}
	writeErr(c, status, msg, "upstream_error")
	return nil, false
}

/*
retrySilently 在「等一等就好」的失败后静默重试，直到超时或上游恢复。

与等待室的区别只有一个：非流式没法往客户端发进度，
所以这里只是「慢一点回」，不发任何提示。

返回 true 时 body/usage/ch 分别是上游给的响应体、用量与承载它的账号，
调用方接着走与首轮完全相同的结算路径。
*/
func retrySilently(
	ctx context.Context,
	c *gin.Context,
	token *apiToken,
	group *services.Group,
	model string,
	body []byte,
	start time.Time,
	callerClient string,
	firstErr error,
) ([]byte, upstreamUsage, *services.UpstreamChannel, bool) {
	deadline := time.Now().Add(jsonHoldMaxWait)
	lastErr := firstErr
	log.Printf("[hold] 非流式请求等待可用账号（模型 %s，最多 %s）：%v",
		model, jsonHoldMaxWait, firstErr)

	for {
		if c.Request.Context().Err() != nil {
			return nil, upstreamUsage{}, nil, false
		}
		if time.Now().After(deadline) {
			log.Printf("[hold] 非流式等待超时（模型 %s）：%v", model, lastErr)
			return nil, upstreamUsage{}, nil, false
		}

		timer := time.NewTimer(holdPollStep)
		select {
		case <-c.Request.Context().Done():
			timer.Stop()
			return nil, upstreamUsage{}, nil, false
		case <-timer.C:
		}

		channels, err := services.SelectChannels(model, group.Name, callerClient, nil)
		if err != nil || len(channels) == 0 {
			if err != nil {
				lastErr = err
			}
			continue
		}

		ch := channels[0]
		if !services.RateLimitAcquire(ch) {
			continue
		}
		respBody, usage, err := func() ([]byte, upstreamUsage, error) {
			defer services.RateLimitRelease(ch)
			return forwardJSON(ctx, ch, body, model)
		}()
		if err != nil {
			lastErr = err
			services.MarkChannelFailureWithCooldown(ch.ID, err.Error(), upstreamErrorCooldown(err))
			logChannelAttemptFailure(token, ch, model, time.Since(start), err.Error())
			// 请求本身写错了：再等也不会好。
			if classifyFailureForHold(err) == channelFailureFatal {
				return nil, upstreamUsage{}, nil, false
			}
			continue
		}

		log.Printf("[hold] 非流式请求等到账号「%s」（已等待 %s）",
			ch.Name, time.Since(start).Round(time.Second))
		services.MarkChannelSuccess(ch.ID)
		return rewriteResponseModel(respBody, model), usage, ch, true
	}
}

// streamTranslator 把上游的 chat-completions 流翻译成目标协议的流。
//
// 三种协议的流都是 SSE，但事件的名称与结构完全不同，所以逐行翻译。
// 翻译器只管「说什么」，不碰网络与计费 —— 那些由 relayUpstream 统一负责，
// 保证无论哪种协议，用量统计与扣费时机都一致。
type streamTranslator interface {
	// Start 在开始转发前调用，用于发出协议要求的起始事件。
	Start(model string) [][]byte
	// Translate 翻译上游的一行 SSE。返回要发给客户端的若干行。
	Translate(line []byte) [][]byte
	// Finish 在流结束后调用，用于补发收尾事件（含 usage）。
	Finish(usage upstreamUsage) [][]byte
	/*
		FinishError 用于「这一轮请求到此为止，但没有成功」的收尾。

		必须走**协议自己的错误事件**，不能让流以正常结束的姿态收场 ——
		用户反馈过这个问题：

		> 最终如果彻底结束了，就返回报错啊，而不是返回对话结束状态码，
		> 不然 agent 会误认为会话正常结束的

		agent（Codex / Claude Code）判断「这轮成没成功」看的是流里的收尾事件：
		chat 看 [DONE]，Responses 看 response.completed / response.failed，
		Anthropic 看 message_stop / error。收尾成正常事件的话，
		等待期间那句提示语就成了模型的最终答复，agent 以为一切正常 ——
		用户回到电脑前只看到一句「正在调度」，却不知道请求其实失败了。
	*/
	FinishError(message string) [][]byte
}

// relayUpstream 流式：选账号 → 建连 → 转发；全部失败时按需进等待室。
//
// 返回值 handled 表示「这条请求已经由本函数处理完」（内容已写出、
// 计费已结算），调用方不要再写任何 HTTP 错误。
//
// 关键点：**建连（openUpstreamStream）不写客户端任何字节**，
// 所以前几次尝试都失败时，客户端那边还什么都不知道 —— 我们既有机会
// 换账号，也有机会「占住连接等账号恢复」，而不是被迫先把 200 发出去。
func relayUpstream(
	c *gin.Context,
	token *apiToken,
	group *services.Group,
	model string,
	body []byte,
	start time.Time,
	translator streamTranslator,
	writeErr errWriterFunc,
) bool {
	// 与 callUpstream 同一处理：把等待提示语从上下文里剥掉。
	body = stripHoldNotices(body)

	if err := reserveBilling(c, token, group, model, body); err != nil {
		writeBillingError(c, writeErr, err)
		return false
	}
	defer releaseBillingHold(c, token)

	excluded := map[int64]struct{}{}
	var lastErr error

	// 调用方标识（require_caller 白名单过滤用），与非流式路径同一规则。
	callerClient := ""
	if token != nil {
		callerClient = token.CallerClient
	}

	for attempt := 0; attempt < maxChannelAttempts; attempt++ {
		channels, err := services.SelectChannels(model, group.Name, callerClient, excluded)
		if err != nil {
			if lastErr == nil {
				lastErr = errors.New("没有可用账号，请在后台检查账号状态与模型配置")
			}
			break
		}

		ch := channels[0]
		excluded[ch.ID] = struct{}{}

		// 账号级限流占位（与非流式同一条规则）：TryAcquire 失败说明
		// 该账号被并发请求抢先占满名额，跳过换下一个候选。
		if !services.RateLimitAcquire(ch) {
			lastErr = fmt.Errorf("%w：账号「%s」", errChannelRateLimited, ch.Name)
			log.Printf("[gateway] 账号「%s」已达速率上限，跳过本次尝试", ch.Name)
			continue
		}

		// 快照里含输入与上游上下文原文，换账号重试时不变（body 与模型相同），
		// 输出由 forwardOpenedStream 边转发边累积。
		snapshot := billingSnapshotFor(c, model, body)
		opened, err := func() (*openedStream, error) {
			defer services.RateLimitRelease(ch)
			return openUpstreamStream(c, ch, body, model)
		}()
		if err != nil {
			// 连接尚未建立、客户端一个字节都没收到 —— 可以换下一个账号重试。
			lastErr = err
			services.MarkChannelFailureWithCooldown(ch.ID, err.Error(), upstreamErrorCooldown(err))
			logChannelAttemptFailure(token, ch, model, time.Since(start), err.Error())
			log.Printf("[gateway] 账号「%s」流式转发失败: %v", ch.Name, err)

			if isClientError(err) {
				break
			}
			continue
		}

		// 建连成功：开流、转发到底（计费与日志由 forwardOpenedStream 结算）。
		w, stop := beginStreamSession(c, translator, model)
		forwardOpenedStream(c, w, opened, ch, model, token, group, start, translator, snapshot)
		stop()
		return true
	}

	/*
		所有候选账号都没能建起连接，且客户端还没收到任何字节。

		只要失败是「等一等就好」的性质（账号全在冷却、上游 5xx、限流、
		账号被全部禁用、配置缺口），就进等待室占住连接 —— 本地 agent 的
		重试次数是写死的（3~5 次），交回给它们只会把会话弄断，
		而账号往往几十秒到几分钟就恢复了。

		用户的要求：宁可等，也不要断会话（人不在电脑旁时，会话断了
		再补「继续」会让上下文全乱）。所以这里**不再**过滤「等也没用」
		的配置类失败 —— 那类失败在更外层（分组白名单）就被挡掉了。
	*/
	if shouldHoldFor(lastErr, model, group.Name, callerClient) {
		log.Printf("[gateway] 模型 %s 无可用账号（%s），进入等待室：%v",
			model, holdSituation(model, group.Name, callerClient), lastErr)
		return holdUntilAvailable(c, token, group, model, body, start, translator, lastErr)
	}

	msg := "所有可用账号均调用失败"
	if lastErr != nil {
		msg += "：" + lastErr.Error()
	}
	logAllChannelsFailed(c, token, model, start, msg)
	writeErr(c, http.StatusBadGateway, msg, "upstream_error")
	return false
}

// chatPassthrough 是 chat-completions 协议的流翻译器：基本原样转发，
// 只做一处必要的归一化（见 stripRepeatedRole）。
type chatPassthrough struct {
	roleSeen bool
}

func (t *chatPassthrough) Start(string) [][]byte { return nil }

func (t *chatPassthrough) Translate(line []byte) [][]byte {
	return [][]byte{ensureSSEFrame(stripRepeatedRole(line, &t.roleSeen))}
}

func (t *chatPassthrough) Finish(upstreamUsage) [][]byte { return nil }

/*
FinishError 给 chat 流发一个标准的错误帧，然后 [DONE] 收尾。

OpenAI 的流式错误约定：`data: {"error": {...}}`，之后仍是 [DONE]。
SDK 读到 error 字段会抛异常（而不是把等待提示当作模型答复），
[DONE] 则保证连接正常关闭、不让客户端挂在读上面。

`code` 用 `no_available_channel`，与 HTTP 状态码 502 的语义对齐 ——
SDK 侧只看到流时也能判断这是「网关没账号」而不是模型自己的问题。
*/
func (t *chatPassthrough) FinishError(message string) [][]byte {
	payload := map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "upstream_error",
			"code":    "no_available_channel",
		},
	}
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return [][]byte{[]byte("data: [DONE]\n\n")}
	}
	frame := ensureSSEFrame(append([]byte("data: "), bytes.TrimRight(buf.Bytes(), "\n")...))
	return [][]byte{frame, []byte("data: [DONE]\n\n")}
}

/*
ensureSSEFrame 保证一个事件以**空行**结束 —— 这是 SSE 的分帧要求。

背景（线上事故）：读上游的循环会把「空行不转发」（上游用空行分帧，
而多数翻译器自己会补空行，透传上游的空行会造成重复空行）。
但 chatPassthrough 是**原样透传**，它不补空行 —— 于是整条流里一个空行都没有。

后果很严重：按 SSE 规范，事件由空行结束；没有空行时，
客户端会把所有 `data:` 行累积成**同一个事件**，data 被拼成
`{...}\n{...}\n{...}` 这种非法 JSON，解析必然失败。
客户端报「模型没有返回内容」，而网关日志与 nginx 全是 200 ——
两边说法对不上，最难查的那类问题。

注意 curl 手工测试发现不了：人（和我的测试脚本）习惯按行解析，
而真正的 SSE 客户端严格按空行分帧。

幂等：已经以空行结尾的输入不会再追加（chatChunk 等翻译器的输出
本来就带 `\n\n`，经 upstreamConv 转出来后再走这里不能变成三连换行）。
CRLF 一并归一成 LF，避免行尾残留 \r。
*/
func ensureSSEFrame(line []byte) []byte {
	trimmed := bytes.TrimRight(line, "\r\n")
	if len(trimmed) == 0 {
		// 纯空行/心跳残留：没有内容可发，交给调用方按空处理。
		return line
	}
	out := make([]byte, 0, len(trimmed)+2)
	out = append(out, trimmed...)
	out = append(out, '\n', '\n')
	return out
}

/*
stripRepeatedRole 去掉「非首块」delta 里的 role 字段。

为什么必须做：部分上游（实测 OpenCode）**每个 chunk 都带
`delta: {"role":"assistant","content":"..."}`**，而 OpenAI 的标准只在第一块带 role。
后果不是「多一个字段无所谓」——很多客户端把「delta 里出现 role」当作
**新消息开始**的信号，于是每个 token 都开一条新消息，前面收到的内容被反复丢弃，
最终一条完整消息都没有。

客户端看到的是「模型没有返回内容」，而网关侧日志记的是拼接后的正常文本 ——
两边说法完全对不上，极难排查（线上问题就是它）。

归一化是安全的：role 是幂等的，去掉重复的不会改变语义，
只是让流回到标准形状。
*/
func stripRepeatedRole(line []byte, roleSeen *bool) []byte {
	// 快路径：绝大多数块不含 role，直接放行（不做 JSON 解析）。
	if !bytes.Contains(line, []byte(`"role"`)) {
		return line
	}
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) == 0 || !bytes.HasPrefix(trimmed, []byte("data:")) {
		return line
	}
	payload := bytes.TrimSpace(bytes.TrimPrefix(trimmed, []byte("data:")))
	if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
		return line
	}
	var parsed map[string]any
	if json.Unmarshal(payload, &parsed) != nil {
		return line
	}
	choices, _ := parsed["choices"].([]any)
	changed := false
	for _, c := range choices {
		choice, okChoice := c.(map[string]any)
		if !okChoice {
			continue
		}
		delta, okDelta := choice["delta"].(map[string]any)
		if !okDelta {
			continue
		}
		if _, hasRole := delta["role"]; !hasRole {
			continue
		}
		if *roleSeen {
			delete(delta, "role")
			changed = true
		} else {
			*roleSeen = true
		}
	}
	if !changed {
		return line
	}
	converted, err := json.Marshal(parsed)
	if err != nil {
		return line
	}
	/*
		原地替换 JSON 片段，前后缀原样保留。

		不能用 TrimSuffix(line, payload)：行尾有 \n，payload 没有，
		匹配不上就会把原 JSON 与新 JSON 一起发出去 —— 那不是「多一个块」，
		而是**同一行里两段 JSON**，客户端必然解析失败。
		按索引替换对前后缀（"data: "、换行）是否规范化都不敏感。
	*/
	at := bytes.Index(line, payload)
	if at < 0 {
		return line
	}
	out := make([]byte, 0, len(line)+len(converted))
	out = append(out, line[:at]...)
	out = append(out, converted...)
	out = append(out, line[at+len(payload):]...)
	return out
}

/*
rewriteResponseModel 把响应体里的 model 字段改成客户端请求的名字。

流式与非流式都要改，所以做成只看 JSON 结构、不关心协议来源。
只动 model 一个字段，其它字节原样保留（不动 usage、不动内容）。

**必须同时认得 SSE 的 `data: ` 前缀**：流式的每一行都是
`data: {...}`，直接拿整行去 Unmarshal 一定失败 —— 那样改不动任何东西，
而且失败是静默的（函数签名上「改不了就原样返回」），
于是上游模型名一路泄漏给客户端，只有肉眼比对响应才能发现。
（这个坑是被 hold_test 断言「上游名不得泄漏」逮出来的。）

失败就原样返回：改不动一个展示字段，不该让整次调用失败。
*/
func rewriteResponseModel(raw []byte, model string) []byte {
	want := strings.TrimSpace(model)
	if want == "" || len(raw) == 0 {
		return raw
	}

	// SSE 行：剥掉 `data:` 前缀改写正文，再原样拼回去。
	// 前缀与 `data:` 后的空格、行尾换行都要一个字节不差地还回去 ——
	// 这些都是 SSE 分帧的一部分（见 ensureSSEFrame 的说明）。
	trimmed := bytes.TrimLeft(raw, " \t")
	if bytes.HasPrefix(trimmed, []byte("data:")) {
		prefixLen := len(raw) - len(trimmed) + len("data:")
		prefix := raw[:prefixLen]
		rest := raw[prefixLen:]
		body := bytes.TrimLeft(rest, " \t")
		gap := rest[:len(rest)-len(body)]
		payloadEnd := len(body)
		for payloadEnd > 0 && (body[payloadEnd-1] == '\n' || body[payloadEnd-1] == '\r') {
			payloadEnd--
		}
		tail := body[payloadEnd:]
		rewritten := rewriteResponseModel(body[:payloadEnd], want)
		if bytes.Equal(rewritten, body[:payloadEnd]) {
			return raw
		}
		out := make([]byte, 0, prefixLen+len(gap)+len(rewritten)+len(tail))
		out = append(out, prefix...)
		out = append(out, gap...)
		out = append(out, rewritten...)
		out = append(out, tail...)
		return out
	}

	var payload map[string]any
	if json.Unmarshal(bytes.TrimSpace(raw), &payload) != nil {
		return raw
	}
	current, _ := payload["model"].(string)
	if current == want {
		return raw
	}
	payload["model"] = want
	converted, err := json.Marshal(payload)
	if err != nil {
		return raw
	}
	return converted
}
