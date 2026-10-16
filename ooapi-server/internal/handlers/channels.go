package handlers

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/db"
	"ooapi/internal/netguard"
	"ooapi/internal/services"
)

// ---------- 账号 ----------

// Channel 是账号的对外结构。
// UpstreamKey 永远不返回明文 —— 只回「是否已配置」与末四位，
// 与密钥同理：管理页面同样可能被旁观或截图。
type Channel struct {
	ID            int64    `json:"id"`
	Name          string   `json:"name"`
	Vendor        string   `json:"vendor"`
	Method        string   `json:"method"`
	HasCredential bool     `json:"has_credential"`
	AuthExpiresAt int64    `json:"auth_expires_at"`
	BaseURL       string   `json:"base_url"`
	HasKey        bool     `json:"has_key"`
	KeyHint       string   `json:"key_hint"`
	Models        []string `json:"models"`
	GroupName     string   `json:"group_name"`
	Headers       string   `json:"headers"`
	ModelPaths    string   `json:"model_paths"`
	Priority      int      `json:"priority"`
	Weight        int      `json:"weight"`
	Status        int      `json:"status"`
	DisabledBy    string   `json:"disabled_by"`
	StatusNote    string   `json:"status_reason"`
	ResponseMs    int      `json:"response_time_ms"`
	TTFTMs        int      `json:"ttft_ms"`
	UsedCount     int      `json:"used_count"`
	LastError     string   `json:"last_error"`
	LastTestAt    string   `json:"last_test_at"`
	CooldownTo    string   `json:"cooldown_until"`
	CreatedAt     string   `json:"created_at"`
	// 账号级限流配置（0 = 不限）。
	Concurrency int `json:"concurrency"`
	MinGapMs    int `json:"min_gap_ms"`
	MaxPerMin   int `json:"max_per_min"`
	// ContextBilling 是计费口径：auto / full / input_only。
	ContextBilling string `json:"context_billing"`
	// Namespace 是账号命名空间标签（管理侧归类展示，不参与调度与计费）。
	Namespace string `json:"namespace"`
	// Remark 是管理备注，纯展示。
	Remark string `json:"remark"`
	// RequireCaller 是调用方白名单（规范化后的小写逗号列表；空 = 不限制）。
	RequireCaller string `json:"require_caller"`
	// ProxyURL 是该账号的出口代理；空 = 直连。
	ProxyURL string `json:"proxy_url"`
	// TLSFingerprint 是出站 TLS 握手指纹名；空 = 标准库默认。
	TLSFingerprint string `json:"tls_fingerprint"`
	/*
		ModelBindings 是账号内的「上游模型名 → 真实模型 id」绑定。

		上游自造的名字（default-model / fast-model …）看不出是什么模型、
		也没有定价，会让调用按 0 计费。绑定给它们一个身份：
		「这个账号的 default-model 其实就是 glm-5.3」。

		是**账号级**的，不是全局映射 —— 同一个 default-model 在
		WorkBuddy 和别的上游是完全不同的模型。
	*/
	ModelBindings map[string]string `json:"model_bindings"`
}

/*
channelColumns 是账号表在所有查询里的标准列清单。

抽出来是为了让「加了一列却漏改某处」变成一个显眼的改动点：
下面两处查询与 scanChannel 的扫描顺序都以此为准。
（Go 的 database/sql 用运行时数量校验，编译期发现不了这类不一致。）

同步契约：本常量的列数必须等于 channelColumnCount（下方常量），
而 channelColumnCount 必须等于 scanChannel 里的 Scan 目标个数 ——
channel_options_test.go 用假扫描器对这两者做断言，任何一边漂移都会红。
*/
const channelColumns = `id, name, vendor, base_url, api_key, models, group_name,
		        COALESCE(headers, ''), COALESCE(model_paths, ''),
		        context_billing, COALESCE(namespace, ''), COALESCE(remark, ''),
		        COALESCE(require_caller, ''), COALESCE(proxy_url, ''),
		        COALESCE(tls_fingerprint, ''), COALESCE(model_bindings, ''),
		        priority, weight, concurrency, min_gap_ms, max_per_min, status,
		        disabled_by, status_reason,
		        response_time, ttft_ms, used_count, last_error,
		        last_test_at, cooldown_until, created_at, method,
		        COALESCE(auth_credential, '') <> '', auth_expires_at`

// channelColumnCount 是 channelColumns 的列数（也等于 scanChannel 的 Scan 目标数）。
// 单独抽成常量是为了让测试能同时校验「SQL 列数」与「扫描目标数」，
// 避免历史上踩过的「列数与扫描数不一致 → 每行扫描失败 → 账号列表变成空」。
const channelColumnCount = 34

// AdminListChannels 账号列表，需要 channel:view。
func AdminListChannels(c *gin.Context) {
	rows, err := queryRows(
		`SELECT ` + channelColumns + `
		 FROM channels ORDER BY priority DESC, id ASC`,
	)
	if err != nil {
		log.Printf("[channel] 查询失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询账号失败", "server_error")
		return
	}
	defer rows.Close()

	out := []Channel{}
	skipped := 0
	for rows.Next() {
		ch, err := scanChannel(rows)
		if err != nil {
			log.Printf("[channel] 扫描行失败: %v", err)
			skipped++
			continue
		}
		out = append(out, *ch)
	}

	/*
		全部行都扫描失败时明确报错。

		这一条是血泪：列数与扫描数不一致时，每行都会失败并 continue，
		接口返回 200 + 空数组，界面上就是「一个账号都没有」——
		管理员会以为账号被删了，而真正的原因是代码写错了。
		宁可让它 500，也不要给一个会误导人的空列表。
	*/
	if skipped > 0 && len(out) == 0 {
		fail(c, http.StatusInternalServerError,
			"账号数据读取失败：列与查询不匹配（请查看服务日志）", "scan_failed")
		return
	}

	ok(c, gin.H{"items": out})
}

type channelRequest struct {
	Name    string   `json:"name"`
	Vendor  string   `json:"vendor"`
	Method  string   `json:"method"`
	Ticket  string   `json:"ticket"`
	BaseURL string   `json:"base_url"`
	APIKey  string   `json:"api_key"`
	Models  []string `json:"models"`
	// GroupName 是账号所属分组名，空串表示「所有分组都可用」。
	// 用指针区分「没传」与「传了空串」—— 后者是「改回所有分组」这个真实操作：
	// 值类型时它与「没传」无法区分，账号一旦设过分组就再也改不回来，
	// 而界面上看不出原因（其他分组的密钥永远调度不到它）。
	GroupName *string `json:"group_name"`
	// Headers 是上游要求的额外请求头，每行一条 "Key: Value"。
	// 用指针区分「没传」与「传了空串」（后者表示清空）。
	Headers *string `json:"headers"`
	// ModelPaths 是按模型指定上游路径的规则，每行一条 "协议: 模型模式"。
	ModelPaths *string `json:"model_paths"`
	// Priority 与 Status 用指针：0 对它们都是合法值 ——
	// 用零值判断「没传」会让「优先级改为 0」静默失效。
	Priority *int `json:"priority"`
	Weight   *int `json:"weight"`
	Status   *int `json:"status"`
	// 账号级限流。同样用指针：0 = 不限是合法且最常见的值，
	// 必须与「没传」区分 —— 否则前端把并发从 5 改回 0（不限）会被静默忽略。
	Concurrency *int `json:"concurrency"`
	MinGapMs    *int `json:"min_gap_ms"`
	MaxPerMin   *int `json:"max_per_min"`
	// ContextBilling 是计费口径（auto / full / input_only），指针语义同上。
	ContextBilling *string `json:"context_billing"`
	// Namespace 是命名空间标签；指针区分「没传」与「传了空串（清空）」。
	Namespace *string `json:"namespace"`
	// Remark 是管理备注；指针区分「没传」与「传了空串（清空）」。
	Remark *string `json:"remark"`
	// RequireCaller 是调用方白名单（逗号分隔）；空串表示不限制。
	RequireCaller *string `json:"require_caller"`
	// ProxyURL 是出口代理地址（http/https/socks5）；空串表示直连。
	ProxyURL *string `json:"proxy_url"`
	// TLSFingerprint 是握手指纹名；指针区分「没传」与「清空」。
	TLSFingerprint *string `json:"tls_fingerprint"`
	/*
		ModelBindings 是账号内的「上游模型名 → 真实模型 id」绑定。

		用指针区分「没传」与「传空对象（清空全部绑定）」——
		与 Headers / ModelPaths 同一套语义。
		未传时保持原值（编辑账号只改别的字段不会把绑定冲掉）。
	*/
	ModelBindings *map[string]string `json:"model_bindings"`
}

// ---------- 账号级限流与计费口径的取值域 ----------

const (
	channelConcurrencyMax = 1000
	channelMinGapMsMax    = 600000
	channelMaxPerMinMax   = 100000
	// 调用方白名单的条目上限与单项长度（与 services.ParseRequireCaller 一致）。
	channelRequireCallerMaxEntries = 20
	channelRequireCallerMaxChars   = 32
)

// contextBillingModes 是 context_billing 的合法取值。
//
//	auto / full = 输入与输出都计费（默认，与旧行为一致）
//	input_only = 输出不计费（订阅型账号：按上下文计费、生成不额外收费）
var contextBillingModes = map[string]struct{}{
	"auto": {}, "full": {}, "input_only": {},
}

// validateChannelOptions 校验账号级高级配置（限流 / 计费口径 / 命名空间 /
// 备注 / 调用方白名单 / 出口代理）。
// 只有「传了」的字段才校验；范围都从 0 起，0 = 不限。
func validateChannelOptions(req *channelRequest) error {
	check := func(name string, v *int, max int) error {
		if v == nil {
			return nil
		}
		if *v < 0 || *v > max {
			return fmt.Errorf("%s 需在 0 到 %d 之间（0 表示不限）", name, max)
		}
		return nil
	}
	if err := check("并发上限", req.Concurrency, channelConcurrencyMax); err != nil {
		return err
	}
	if err := check("请求最小间隔", req.MinGapMs, channelMinGapMsMax); err != nil {
		return err
	}
	if err := check("每分钟上限", req.MaxPerMin, channelMaxPerMinMax); err != nil {
		return err
	}
	if req.ContextBilling != nil {
		mode := strings.TrimSpace(*req.ContextBilling)
		if _, ok := contextBillingModes[mode]; !ok {
			return errors.New("计费口径只能是 auto / full / input_only")
		}
	}
	if req.Namespace != nil {
		if len([]rune(strings.TrimSpace(*req.Namespace))) > 64 {
			return errors.New("命名空间最长 64 个字符")
		}
	}
	if req.Remark != nil {
		if len([]rune(strings.TrimSpace(*req.Remark))) > 255 {
			return errors.New("备注最长 255 个字符")
		}
	}
	if req.RequireCaller != nil {
		if _, err := normalizeRequireCaller(*req.RequireCaller); err != nil {
			return err
		}
	}
	if req.ProxyURL != nil {
		raw := strings.TrimSpace(*req.ProxyURL)
		if len(raw) > 255 {
			return errors.New("代理地址最长 255 个字符")
		}
		if raw != "" {
			if err := validateProxyURL(raw); err != nil {
				return err
			}
		}
	}
	return nil
}

// normalizeRequireCaller 规范化调用方白名单：去空白、转小写、逗号重连。
//
// 校验上限（20 项 / 单项 32 字符）与调度侧 services.ParseRequireCaller 一致；
// 规范化后存库，调度时不需要再做大小写与空白的兼容处理。
func normalizeRequireCaller(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	items := []string{}
	for _, part := range strings.Split(raw, ",") {
		item := strings.ToLower(strings.TrimSpace(part))
		if item == "" {
			continue
		}
		if len([]rune(item)) > channelRequireCallerMaxChars {
			return "", fmt.Errorf("调用方标识「%s」最长 %d 个字符", item, channelRequireCallerMaxChars)
		}
		items = append(items, item)
	}
	if len(items) > channelRequireCallerMaxEntries {
		return "", fmt.Errorf("调用方白名单最多 %d 项", channelRequireCallerMaxEntries)
	}
	return strings.Join(items, ","), nil
}

// AdminCreateChannel 新建账号，需要 channel:edit。
func AdminCreateChannel(c *gin.Context) {
	// 账号列表有 5 秒缓存，写完必须立刻失效 ——
	// 否则「刚建好就测试/调用」会命中旧缓存，看起来像没生效。
	defer services.MarkChannelsDirty()

	var req channelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	// 设备授权接入方式（kiro / workbuddy / cli / grok）与票据创建走同一条路。
	switch req.Method {
	case "cli", "kiro", "workbuddy", "grok":
		createDeviceChannel(c, &req)
		return
	}
	// 订阅账号（codex / claude-oauth / antigravity）：凭据来自交互式 OAuth 登录，
	// 与设备授权一样不能手填 API Key。
	if _, isLogin := services.UpstreamLoginVendorOfMethod(req.Method); isLogin || req.Ticket != "" {
		createLoginChannel(c, &req)
		return
	}
	if req.Method != "" && req.Method != "api" {
		fail(c, http.StatusBadRequest, services.DeviceUnavailable(req.Vendor), "method_unavailable")
		return
	}
	if err := validateChannelInput(&req, "create"); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_input")
		return
	}

	// SSRF 校验：账号地址会被服务端真的请求（测试连通性、拉取模型），
	// 不校验就能被用来探测内网与云元数据端点。
	if _, err := netguard.AssertPublicURL(req.BaseURL); err != nil {
		fail(c, http.StatusBadRequest, "接口地址不可用："+err.Error(), "invalid_url")
		return
	}

	status := 1
	if req.Status != nil {
		status = *req.Status
		if status != 0 && status != 1 {
			fail(c, http.StatusBadRequest, "状态只能是启用或禁用", "invalid_status")
			return
		}
	}
	priority := 0
	if req.Priority != nil {
		priority = *req.Priority
	}
	weight := 1
	if req.Weight != nil {
		weight = *req.Weight
		if weight < 1 {
			fail(c, http.StatusBadRequest, "权重至少为 1", "invalid_weight")
			return
		}
	}
	// 限流三项默认 0（不限）、计费口径默认 auto —— 未配置的新账号
	// 与旧账号行为一致；只有管理员显式填写才会启用。
	concurrency, minGapMs, maxPerMin := 0, 0, 0
	if req.Concurrency != nil {
		concurrency = *req.Concurrency
	}
	if req.MinGapMs != nil {
		minGapMs = *req.MinGapMs
	}
	if req.MaxPerMin != nil {
		maxPerMin = *req.MaxPerMin
	}
	contextBilling := "auto"
	if req.ContextBilling != nil {
		contextBilling = strings.TrimSpace(*req.ContextBilling)
	}
	namespace := ""
	if req.Namespace != nil {
		namespace = strings.TrimSpace(*req.Namespace)
	}
	remark := ""
	if req.Remark != nil {
		remark = strings.TrimSpace(*req.Remark)
		if len([]rune(remark)) > 255 {
			fail(c, http.StatusBadRequest, "备注最长 255 个字符", "invalid_remark")
			return
		}
	}
	requireCaller := ""
	if req.RequireCaller != nil {
		normalized, err := normalizeRequireCaller(*req.RequireCaller)
		if err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_require_caller")
			return
		}
		requireCaller = normalized
	}
	proxyURL := ""
	if req.ProxyURL != nil {
		proxyURL = strings.TrimSpace(*req.ProxyURL)
		if proxyURL != "" {
			if err := validateProxyURL(proxyURL); err != nil {
				fail(c, http.StatusBadRequest, err.Error(), "invalid_proxy_url")
				return
			}
		}
	}
	tlsFingerprint := services.TLSProfileOff
	if req.TLSFingerprint != nil {
		parsed, err := services.ParseTLSProfile(*req.TLSFingerprint)
		if err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_tls_fingerprint")
			return
		}
		tlsFingerprint = parsed
	}

	sealedChannelKey, err := services.SealChannelAPIKey(strings.TrimSpace(req.APIKey))
	if err != nil {
		log.Printf("[channel] 加密密钥失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建账号失败", "server_error")
		return
	}

	res, err := exec(
		`INSERT INTO channels (name, vendor, base_url, api_key, models, group_name, headers, model_paths,
		                       model_bindings,
		                       context_billing, namespace, remark, require_caller, proxy_url, tls_fingerprint,
		                       priority, weight, concurrency, min_gap_ms, max_per_min, status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		strings.TrimSpace(req.Name), strings.TrimSpace(req.Vendor), strings.TrimSpace(req.BaseURL),
		sealedChannelKey, strings.Join(normalizeModelList(req.Models), ","),
		optionalGroupName(req.GroupName), normalizeHeaders(req.Headers), normalizeModelPaths(req.ModelPaths),
		requestBindingsRaw(req.ModelBindings),
		contextBilling, namespace, remark, requireCaller, proxyURL, string(tlsFingerprint),
		priority, weight, concurrency, minGapMs, maxPerMin, status,
	)
	if err != nil {
		log.Printf("[channel] 插入失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建账号失败", "server_error")
		return
	}

	id, _ := res.LastInsertId()
	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 创建账号「%s」(%s)", operator.Username, req.Name, req.BaseURL)
	}
	auditLog(c, "创建账号", req.Name)

	// 绑定要连带写入定价与能力参数，否则「绑了却查不到价」（按 0 计费）。
	if req.ModelBindings != nil {
		applyBindingsSideEffects(*req.ModelBindings)
	}
	ensureDeclaredRealModels(normalizeModelList(req.Models))

	ch, err := channelByID(id)
	if err != nil {
		ok(c, gin.H{"id": id})
		return
	}
	ok(c, ch)
}

// AdminUpdateChannel 修改账号，需要 channel:edit。
func AdminUpdateChannel(c *gin.Context) {
	defer services.MarkChannelsDirty()

	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "账号 ID 不正确", "bad_request")
		return
	}

	existing, err := channelByID(id)
	if err != nil {
		fail(c, http.StatusNotFound, "账号不存在", "not_found")
		return
	}

	var req channelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	// 订阅渠道的「重新授权」：带登录句柄进来时，先写凭据再继续处理其它字段。
	// 返回 true 表示响应已经写完，调用方直接返回。
	if _, isLogin := services.UpstreamLoginVendorOfMethod(existing.Method); isLogin {
		if relinkLoginChannel(c, existing, &req) {
			return
		}
	}

	if req.Ticket != "" || (req.Method != "" && req.Method != existing.Method) {
		fail(c, 400, "接入方式不可直接切换；请创建对应渠道或重新一键绑定", "method_mismatch")
		return
	}
	// 设备授权渠道（cli / kiro / workbuddy / grok）与订阅渠道（codex / claude-oauth /
	// antigravity）：地址、凭据由授权链路维护，普通编辑不能改厂商、Key、协议路径或
	// 地址（地址由服务端按账号区域/版本/接入方式推导），避免把加密凭据与官方地址
	// 拆散、或把账号指到另一个域。
	switch {
	case existing.Method == "cli", existing.Method == "kiro",
		existing.Method == "workbuddy", existing.Method == "grok":
		expectVendor := "cline"
		if existing.Method != "cli" {
			expectVendor = existing.Method
		}
		baseChanged := strings.TrimRight(strings.TrimSpace(req.BaseURL), "/") != "" &&
			strings.TrimRight(strings.TrimSpace(req.BaseURL), "/") != strings.TrimRight(strings.TrimSpace(existing.BaseURL), "/")
		if (req.Vendor != "" && req.Vendor != expectVendor) || req.APIKey != "" || baseChanged ||
			(req.ModelPaths != nil && strings.TrimSpace(*req.ModelPaths) != "") {
			fail(c, 400, "设备授权渠道必须保留官方地址与账号认证，凭据请通过一键绑定更新", "invalid_credential")
			return
		}
	default:
		if _, isLogin := services.UpstreamLoginVendorOfMethod(existing.Method); isLogin {
			expectVendor := services.UpstreamVendorForLoginMethod(existing.Method)
			baseChanged := strings.TrimRight(strings.TrimSpace(req.BaseURL), "/") != "" &&
				strings.TrimRight(strings.TrimSpace(req.BaseURL), "/") != strings.TrimRight(strings.TrimSpace(existing.BaseURL), "/")
			if (req.Vendor != "" && req.Vendor != expectVendor) || req.APIKey != "" || baseChanged ||
				(req.ModelPaths != nil && strings.TrimSpace(*req.ModelPaths) != "") {
				fail(c, 400, "订阅渠道必须保留官方地址与账号认证，凭据请通过「重新授权」更新", "invalid_credential")
				return
			}
		}
	}

	// 更新时 api_key 留空表示「保持原值」—— 前端只拿到掩码，
	// 不能把掩码当新密钥写回去。
	if err := validateChannelInputFor(&req, "update", id); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_input")
		return
	}

	if strings.TrimSpace(req.BaseURL) != "" && strings.TrimSpace(req.BaseURL) != existing.BaseURL {
		if _, err := netguard.AssertPublicURL(req.BaseURL); err != nil {
			fail(c, http.StatusBadRequest, "接口地址不可用："+err.Error(), "invalid_url")
			return
		}
	}

	updates := map[string]any{}
	if req.Status != nil && *req.Status != 0 && *req.Status != 1 {
		fail(c, http.StatusBadRequest, "状态只能是启用或禁用", "invalid_status")
		return
	}

	if v := strings.TrimSpace(req.Name); v != "" {
		updates["name"] = v
	}
	if v := strings.TrimSpace(req.Vendor); v != "" {
		updates["vendor"] = v
	}
	if v := strings.TrimSpace(req.BaseURL); v != "" {
		updates["base_url"] = v
	}
	if v := strings.TrimSpace(req.APIKey); v != "" {
		sealed, sealErr := services.SealChannelAPIKey(v)
		if sealErr != nil {
			log.Printf("[channel] 加密密钥失败: %v", sealErr)
			fail(c, http.StatusInternalServerError, "更新账号失败", "server_error")
			return
		}
		updates["api_key"] = sealed
	}
	if req.Models != nil {
		updates["models"] = strings.Join(normalizeModelList(req.Models), ",")
	}
	// 分组：传空串 = 改回「所有分组」（指针语义，见字段注释）。
	if req.GroupName != nil {
		updates["group_name"] = strings.TrimSpace(*req.GroupName)
	}
	if req.Headers != nil {
		updates["headers"] = normalizeHeaders(req.Headers)
	}
	if req.ModelPaths != nil {
		updates["model_paths"] = normalizeModelPaths(req.ModelPaths)
	}
	if req.ModelBindings != nil {
		updates["model_bindings"] = requestBindingsRaw(req.ModelBindings)
	}
	// 限流三项：0 是合法值（不限），必须用指针判断「传了没有」才能改回 0。
	if req.Concurrency != nil {
		updates["concurrency"] = *req.Concurrency
	}
	if req.MinGapMs != nil {
		updates["min_gap_ms"] = *req.MinGapMs
	}
	if req.MaxPerMin != nil {
		updates["max_per_min"] = *req.MaxPerMin
	}
	// 计费口径：枚举已在 validateChannelInput 里校验；这里只在传了时更新。
	if req.ContextBilling != nil {
		updates["context_billing"] = strings.TrimSpace(*req.ContextBilling)
	}
	// 命名空间：指针语义 —— 传空串表示清空。
	if req.Namespace != nil {
		namespace := strings.TrimSpace(*req.Namespace)
		if len([]rune(namespace)) > 64 {
			fail(c, http.StatusBadRequest, "命名空间最长 64 个字符", "invalid_namespace")
			return
		}
		updates["namespace"] = namespace
	}
	// 备注：指针语义 —— 传空串表示清空。
	if req.Remark != nil {
		remark := strings.TrimSpace(*req.Remark)
		if len([]rune(remark)) > 255 {
			fail(c, http.StatusBadRequest, "备注最长 255 个字符", "invalid_remark")
			return
		}
		updates["remark"] = remark
	}
	// 调用方白名单：规范化（小写、去空白）后存库；空串 = 取消限制。
	if req.RequireCaller != nil {
		normalized, err := normalizeRequireCaller(*req.RequireCaller)
		if err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_require_caller")
			return
		}
		updates["require_caller"] = normalized
	}
	// 出口代理：空串 = 改回直连。
	if req.ProxyURL != nil {
		proxyURL := strings.TrimSpace(*req.ProxyURL)
		if proxyURL != "" {
			if err := validateProxyURL(proxyURL); err != nil {
				fail(c, http.StatusBadRequest, err.Error(), "invalid_proxy_url")
				return
			}
		}
		updates["proxy_url"] = proxyURL
	}
	// TLS 指纹：空串 = 关掉模拟（恢复标准库握手）。
	if req.TLSFingerprint != nil {
		profile, err := services.ParseTLSProfile(*req.TLSFingerprint)
		if err != nil {
			fail(c, http.StatusBadRequest, err.Error(), "invalid_tls_fingerprint")
			return
		}
		updates["tls_fingerprint"] = string(profile)
	}
	if req.Priority != nil {
		updates["priority"] = *req.Priority
	}
	if req.Weight != nil {
		if *req.Weight < 1 {
			fail(c, http.StatusBadRequest, "权重至少为 1", "invalid_weight")
			return
		}
		updates["weight"] = *req.Weight
	}
	if req.Status != nil {
		updates["status"] = *req.Status
		// 管理员手动启停：标记来源，避免被后续的自动测试覆盖。
		if *req.Status == 1 {
			updates["disabled_by"] = ""
			updates["status_reason"] = ""
			updates["cooldown_until"] = nil
		} else {
			updates["disabled_by"] = "manual"
			updates["status_reason"] = "管理员手动禁用"
		}
	}

	if len(updates) == 0 {
		fail(c, http.StatusBadRequest, "没有需要更新的字段", "nothing_to_update")
		return
	}

	sets := make([]string, 0, len(updates))
	args := make([]any, 0, len(updates)+1)
	for k, v := range updates {
		sets = append(sets, k+" = ?")
		args = append(args, v)
	}
	args = append(args, id)

	if _, err := exec("UPDATE channels SET "+strings.Join(sets, ", ")+" WHERE id = ?", args...); err != nil {
		log.Printf("[channel] 更新失败: %v", err)
		fail(c, http.StatusInternalServerError, "更新账号失败", "server_error")
		return
	}

	if operator, okOp := currentUser(c); okOp {
		log.Printf("[admin] %s 更新账号 %d", operator.Username, id)
	}
	auditLog(c, "更新账号", "账号 ID "+strconv.FormatInt(id, 10))

	// 与创建同一处理：新绑的别名要连带写入定价与能力参数。
	if req.ModelBindings != nil {
		applyBindingsSideEffects(*req.ModelBindings)
	}
	if req.Models != nil {
		ensureDeclaredRealModels(normalizeModelList(req.Models))
	}

	ch, err := channelByID(id)
	if err != nil {
		ok(c, gin.H{"id": id})
		return
	}
	ok(c, ch)
}

// AdminDeleteChannel 删除账号，需要 channel:delete。
func AdminDeleteChannel(c *gin.Context) {
	defer services.MarkChannelsDirty()

	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "账号 ID 不正确", "bad_request")
		return
	}

	res, err := exec("DELETE FROM channels WHERE id = ?", id)
	if err != nil {
		fail(c, http.StatusInternalServerError, "删除失败", "server_error")
		return
	}
	if affected, _ := res.RowsAffected(); affected == 0 {
		fail(c, http.StatusNotFound, "账号不存在", "not_found")
		return
	}

	auditLog(c, "删除账号", "账号 ID "+strconv.FormatInt(id, 10))
	ok(c, gin.H{"id": id})
}

// AdminTestChannel 连通性测试，需要 channel:edit。
//
// 两个设计要点：
//  1. 记录 **TTFT（首 token 耗时）** 而不是只记总耗时。总耗时把「思考 + 生成全文」
//     都算进去，思考型模型与长回答会被误判成坏账号；用户体感是「多久开始出字」。
//  2. 测试**绝不修改 status**。status 是管理员的开关，测试成功不能把
//     管理员手动禁用的账号复活 —— 只有自动禁用（disabled_by=auto）才由测试结果接管。
func AdminTestChannel(c *gin.Context) {
	// 测试会写回 response_time / last_error / 自动禁用状态，
	// 这些都会影响调度，因此同样要让缓存失效。
	defer services.MarkChannelsDirty()

	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		fail(c, http.StatusBadRequest, "账号 ID 不正确", "bad_request")
		return
	}

	ch, err := channelByID(id)
	if err != nil {
		fail(c, http.StatusNotFound, "账号不存在", "not_found")
		return
	}

	// 取出真实密钥做测试（对外结构里只有掩码），
	// 自定义头也要一起取：有些上游（OpenCode Go）缺了会话头就必然失败。
	// 出口代理同样取出：测试必须走与正式转发相同的出口，
	// 否则「测试通过、正式失败」（或反之）这类最难查的问题就会出现。
	var baseURL, apiKey, modelsRaw, headersRaw, proxyURL string
	if err := db.DB.QueryRow(
		"SELECT base_url, api_key, models, COALESCE(headers, ''), COALESCE(proxy_url, '') FROM channels WHERE id = ?", id,
	).Scan(&baseURL, &apiKey, &modelsRaw, &headersRaw, &proxyURL); err != nil {
		fail(c, http.StatusInternalServerError, "读取账号配置失败", "server_error")
		return
	}
	apiKey = services.OpenChannelAPIKey(apiKey)

	probeModel := firstModel(modelsRaw)
	if marker := services.DeviceCredentialMarker(ch.Method, id); marker != "" {
		apiKey = marker
		// 设备授权渠道常以空模型列表创建：探测必须用一个上游确实支持的模型名，
		// 否则「模型不存在」会被误报成账号故障（甚至自动禁用）。
		if probeModel == "" {
			probeModel = deviceProbeModel(ch.Method)
		}
	}
	// 订阅渠道同样用内部标识换凭据，且探测模型不能用通用兜底值。
	if _, isLogin := services.UpstreamLoginVendorOfMethod(ch.Method); isLogin {
		apiKey = services.LoginCredentialMarker(ch.Method, id)
		if probeModel == "" {
			probeModel = deviceProbeModel(ch.Method)
		}
	}
	/*
		OpenCode 官方域渠道的测试走本机桥接，而不是直连上游。

		直连必然被上游的客户端校验拒绝（403 FreeTierError）——
		测试按钮会把一个完全可用的渠道判成坏账号并自动禁用
		（线上实测踩过：渠道 7 被测试按钮打进了 auto 禁用）。
		桥接渠道的测试必须与正式转发走同一条链路。
	*/
	probeCh := &services.UpstreamChannel{Vendor: ch.Vendor, BaseURL: baseURL, Models: []string{probeModel}}
	if services.UsesOpenCodeBridge(probeCh) {
		probe := probeChannelViaBridge(ch.Vendor, baseURL, probeModel)
		now := time.Now()
		applyChannelProbeResult(c, id, ch, probe, now)
		return
	}
	probe := ProbeChannelForMethod(baseURL, apiKey, probeModel, headersRaw, proxyURL, ch.Method)
	applyChannelProbeResult(c, id, ch, probe, time.Now())
}

/*
applyChannelProbeResult 把一次探测结果写回账号并回应管理端。

抽成函数的原因：桥接渠道与直连渠道的探测方式完全不同（桥接走本机 serve），
但**结果处理必须逐字一致** —— 两条路径如果在「自动禁用/自动恢复」上有
分歧，就会出现「同一账号测两次结论不同」这种最难排查的问题。

c 为空时只落库不回应（供后台自检复用）；正常测试传 gin 上下文。
*/
func applyChannelProbeResult(c *gin.Context, id int64, ch *Channel, probe probeResult, now time.Time) {
	if probe.OK {
		_, err := exec(
			`UPDATE channels
			 SET response_time = ?, ttft_ms = ?, last_test_at = ?, last_error = '', cooldown_until = NULL
			 WHERE id = ?`,
			probe.TotalMs, probe.TTFTMs, now, id,
		)
		if err != nil {
			log.Printf("[channel] 写入测试结果失败: %v", err)
		}

		// 自动禁用的账号在测试通过后恢复；手动禁用的保持禁用。
		if ch.Status != 1 && ch.DisabledBy == "auto" {
			if _, err := exec(
				`UPDATE channels SET status = 1, disabled_by = '', status_reason = ''
				 WHERE id = ? AND disabled_by = 'auto'`, id,
			); err != nil {
				log.Printf("[channel] 自动恢复账号失败: %v", err)
			}
		}

		log.Printf("[channel] 账号「%s」测试通过（首Token %dms / 总 %dms）",
			ch.Name, probe.TTFTMs, probe.TotalMs)

		if c != nil {
			ok(c, gin.H{
				"success":  true,
				"ttft_ms":  probe.TTFTMs,
				"total_ms": probe.TotalMs,
				"reply":    probe.Reply,
				"model":    probe.Model,
			})
		}
		return
	}

	// 测试失败。
	//
	// 是否自动禁用有讲究：网络层错误（连不上/超时）多半是瞬时抖动，
	// 不该因为一次失败就停掉一个好账号；而上游明确返回错误状态码
	// （401/403/429/5xx）说明配置或额度真有问题，才自动禁用。
	shouldDisable := probe.Fatal && ch.Status == 1
	if shouldDisable {
		if _, err := exec(
			`UPDATE channels SET status = 2, disabled_by = 'auto', status_reason = ?,
			        last_error = ?, last_test_at = ?
			 WHERE id = ? AND status = 1`,
			truncate(probe.Error, 250), truncate(probe.Error, 480), now, id,
		); err != nil {
			log.Printf("[channel] 自动禁用账号失败: %v", err)
		}
	} else {
		if _, err := exec(
			"UPDATE channels SET last_error = ?, last_test_at = ? WHERE id = ?",
			truncate(probe.Error, 480), now, id,
		); err != nil {
			log.Printf("[channel] 写入错误信息失败: %v", err)
		}
	}

	log.Printf("[channel] 账号「%s」测试失败: %s", ch.Name, probe.Error)

	if c == nil {
		return
	}
	msg := "账号不可用：" + probe.Error
	if shouldDisable {
		msg += "（已自动禁用）"
	}
	fail(c, http.StatusBadGateway, msg, "test_failed")
}

// AdminFetchModels 从上游拉取模型列表，需要 channel:edit。
//
// 支持两种调用方式：
//   - 传 id：用库里已存的地址与密钥
//   - 传 base_url + api_key：新建账号时还没落库，先试探
func AdminFetchModels(c *gin.Context) {
	var req struct {
		ID       int64   `json:"id"`
		BaseURL  string  `json:"base_url"`
		APIKey   string  `json:"api_key"`
		Headers  *string `json:"headers"`
		ProxyURL *string `json:"proxy_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}

	base := strings.TrimSpace(req.BaseURL)
	key := strings.TrimSpace(req.APIKey)
	headers := ""
	if req.Headers != nil {
		headers = normalizeHeaders(req.Headers)
	}
	proxyURL := ""
	if req.ProxyURL != nil {
		proxyURL = strings.TrimSpace(*req.ProxyURL)
		if proxyURL != "" {
			if err := validateProxyURL(proxyURL); err != nil {
				fail(c, http.StatusBadRequest, err.Error(), "invalid_proxy_url")
				return
			}
		}
	}

	// 只补「请求里缺失的部分」：同时传 id 与 key 但没传地址时，
	// 必须取该账号自己的地址，否则会把 A 账号的密钥发给 B 上游。
	//
	// headers 与 proxy_url 也一并回查：表单编辑已有账号时通常只传 id，
	// 缺了自定义头会让「拉取模型」在需要会话头的上游上永远失败；
	// 缺了代理则会用错出口（甚至直连出网）。
	if req.ID > 0 && (key == "" || base == "" || headers == "" || proxyURL == "") {
		var dbBase, dbKey, dbHeaders, dbProxy string
		err := db.DB.QueryRow(
			"SELECT base_url, api_key, COALESCE(headers, ''), COALESCE(proxy_url, '') FROM channels WHERE id = ?", req.ID,
		).Scan(&dbBase, &dbKey, &dbHeaders, &dbProxy)
		if err == nil {
			dbKey = services.OpenChannelAPIKey(dbKey)
			if key == "" {
				key = strings.Split(dbKey, "\n")[0]
			}
			if base == "" {
				base = dbBase
			}
			if headers == "" {
				headers = dbHeaders
			}
			if proxyURL == "" {
				proxyURL = dbProxy
			}
		}
	}

	if req.ID > 0 {
		ch, err := channelByID(req.ID)
		if err != nil {
			fail(c, 404, "账号不存在", "not_found")
			return
		}
		if marker := services.DeviceCredentialMarker(ch.Method, req.ID); marker != "" {
			if req.APIKey != "" || (req.BaseURL != "" && !deviceBaseLooksOfficial(ch.Vendor, req.BaseURL)) {
				fail(c, 400, "设备授权渠道不接受 API Key 或非官方地址", "invalid_credential")
				return
			}
			base = ch.BaseURL
			key = marker
		} else if _, isLogin := services.UpstreamLoginVendorOfMethod(ch.Method); isLogin {
			/*
				订阅渠道（codex / claude-oauth / antigravity）：地址与凭据都由服务端
				按登录结果推导，不接受请求体里的任何一项 —— 与设备渠道同一原则。
			*/
			if req.APIKey != "" || (req.BaseURL != "" && strings.TrimRight(req.BaseURL, "/") != services.LoginChannelBase(ch.Method)) {
				fail(c, 400, "订阅渠道不接受 API Key 或非官方地址", "invalid_credential")
				return
			}
			base = ch.BaseURL
			key = services.LoginCredentialMarker(ch.Method, req.ID)
		}
	}
	if key == "" {
		fail(c, http.StatusBadRequest, "请先填写上游密钥", "no_key")
		return
	}
	if base == "" {
		fail(c, http.StatusBadRequest, "请先填写接口地址", "no_url")
		return
	}

	// 与创建账号同样的 SSRF 校验 —— 这个接口会真的去请求该地址。
	if _, err := netguard.AssertPublicURL(base); err != nil {
		fail(c, http.StatusBadRequest, "接口地址不可用："+err.Error(), "invalid_url")
		return
	}

	/*
		OpenCode 官方域渠道的模型列表从本机桥接读。

		直连上游取列表同样会被客户端校验拒绝（403）——「从上游获取模型列表」
		会让管理员以为账号有问题。serve 的模型目录（/config/providers）
		就是官方客户端看到的同一份，用它填表单口径一致。
	*/
	if services.UsesOpenCodeBridge(&services.UpstreamChannel{Vendor: channelVendorForFetch(req.ID, base), BaseURL: base}) {
		models, err := bridgeUpstreamModels()
		if err != nil {
			fail(c, http.StatusBadGateway, "从桥接服务读取模型列表失败："+err.Error(), "fetch_failed")
			return
		}
		ok(c, gin.H{"models": models, "count": len(models)})
		return
	}

	models, err := fetchUpstreamModelsWithProxy(base, key, headers, proxyURL)
	if err != nil {
		fail(c, http.StatusBadGateway, "拉取模型失败："+err.Error(), "fetch_failed")
		return
	}

	ok(c, gin.H{"models": models, "count": len(models)})
}

// ---------- 上游交互 ----------

// probeResult 是一次连通性测试的结果。
type probeResult struct {
	OK      bool
	TTFTMs  int
	TotalMs int
	Reply   string
	Model   string
	Error   string
	// Fatal 表示「上游明确拒绝」，值得自动禁用；
	// 网络层错误（连不上/超时）为 false，避免一次抖动停掉好账号。
	Fatal bool
}

// ProbeChannel 向上游发一次最小请求，测连通性。
//
// 用 /chat/completions 而不是 /models：后者只验证「能不能拿到模型列表」，
// 而真正要验证的是「能不能正常对话」——两者授权范围与限流策略常常不同。
func ProbeChannel(baseURL, apiKey, model, headers string) probeResult {
	return ProbeChannelWithProxy(baseURL, apiKey, model, headers, "")
}

// ProbeChannelWithProxy 是带出口代理的连通性测试。
// proxyURL 为空时与 ProbeChannel 完全等价（走共享的 probeClient）。
func ProbeChannelWithProxy(baseURL, apiKey, model, headers, proxyURL string) probeResult {
	return ProbeChannelForMethod(baseURL, apiKey, model, headers, proxyURL, "")
}

// ProbeChannelForMethod 是带「接入方式」的连通性测试。
//
// 为什么需要它：订阅渠道的上游端点各不相同（Codex 只认 /responses、
// Claude 只认 /messages），一律打 /chat/completions 会得到 404，
// 被误报成「账号不可用」甚至自动禁用 —— 而账号其实完全正常。
func ProbeChannelForMethod(baseURL, apiKey, model, headers, proxyURL, method string) probeResult {
	if strings.TrimSpace(model) == "" {
		model = "gpt-3.5-turbo"
	}

	url := strings.TrimRight(strings.TrimSpace(baseURL), "/") + probePathForMethod(method)

	body, _ := json.Marshal(map[string]any{
		"model":      model,
		"messages":   []map[string]string{{"role": "user", "content": "hi"}},
		"max_tokens": 1,
		"stream":     false,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return probeResult{Error: "构造请求失败：" + err.Error()}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	// 与正式转发用同一套头：测试通不代表正式通，
	// 如果测试不带自定义头，OpenCode Go 这类上游会永远测不过。
	applyCustomHeaders(req, headers)

	start := time.Now()
	// 代理配置错误（含被 netguard 拒绝）算账号级故障：地址是管理员填的，
	// 不修好这个账号就是不可用 —— 与网络抖动区分开，标记 Fatal。
	resp, err := doChannelRequest(req, proxyURL, probeClient)
	total := int(time.Since(start).Milliseconds())

	if err != nil {
		if errors.Is(err, ErrProxyRejected) {
			return probeResult{TotalMs: total, Error: err.Error(), Fatal: true}
		}
		// 网络层失败：不自动禁用
		return probeResult{TotalMs: total, Error: "无法连接上游：" + err.Error(), Fatal: false}
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// 上游明确拒绝：值得自动禁用
		return probeResult{
			TotalMs: total,
			Error:   fmt.Sprintf("上游返回 %d：%s", resp.StatusCode, truncate(string(raw), 200)),
			Fatal:   true,
		}
	}

	// 解析出回复内容与用量，作为「确实能用」的证据 ——
	// 只看状态码不够：部分中转会返回 200 但内容是错误提示。
	var parsed struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return probeResult{TotalMs: total, Error: "响应不是合法 JSON：" + truncate(string(raw), 120), Fatal: true}
	}
	if parsed.Error != nil {
		return probeResult{TotalMs: total, Error: "上游返回错误：" + parsed.Error.Message, Fatal: true}
	}
	if len(parsed.Choices) == 0 {
		return probeResult{TotalMs: total, Error: "上游未返回任何回复内容", Fatal: true}
	}

	reply := parsed.Choices[0].Message.Content

	/*
		非流式请求拿不到真实的首 token 时间 —— 响应是一次性返回的。
		这里用「总耗时」作为 TTFT 的近似值，并在文案上标明是估算。

		要拿真实 TTFT 必须发流式请求并测第一个 chunk 的到达时间。
		那会让测试更慢也更复杂（要处理 SSE 分帧），当前阶段不值得。
	*/
	return probeResult{
		OK:      true,
		TTFTMs:  total,
		TotalMs: total,
		Reply:   truncate(reply, 200),
		Model:   parsed.Model,
	}
}

// fetchUpstreamModels 拉取上游模型列表。
func fetchUpstreamModels(baseURL, apiKey, headers string) ([]string, error) {
	return fetchUpstreamModelsWithProxy(baseURL, apiKey, headers, "")
}

// fetchUpstreamModelsWithProxy 是带出口代理的拉取；proxyURL 为空时行为不变。
func fetchUpstreamModelsWithProxy(baseURL, apiKey, headers, proxyURL string) ([]string, error) {
	url := strings.TrimRight(strings.TrimSpace(baseURL), "/") + "/models"

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "application/json")
	applyCustomHeaders(req, headers)

	resp, err := doChannelRequest(req, proxyURL, probeClient)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("上游返回 %d：%s", resp.StatusCode, truncate(string(raw), 160))
	}

	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, errors.New("响应格式无法解析")
	}

	// 去重后排序：不同上游可能返回重复项，顺序也不稳定，
	// 直接展示会给管理员造成「怎么有两个一样的」的困惑。
	seen := map[string]struct{}{}
	out := []string{}
	for _, m := range parsed.Data {
		id := strings.TrimSpace(m.ID)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}

	if len(out) == 0 {
		return nil, errors.New("上游未返回任何模型")
	}
	return out, nil
}

var probeClient = &http.Client{
	Timeout:       35 * time.Second,
	CheckRedirect: netguard.CheckRedirect,
	Transport:     netguard.PublicTransport(),
}

// ---------- 辅助 ----------

// validateChannelInput 校验账号输入。
//
// mode 的语义必须区分清楚，否则「只改一个字段」的请求会被要求补齐全部字段：
//   - "create"：新建，名称与地址必填
//   - "update"：局部更新，只校验「传了的字段」是否合法；
//     没传的字段表示保持原值，不参与校验
//
// 这是实测踩到的：前端点「启用/禁用」只发 {status: 0}，
// 无条件要求名称会让开关按钮永远报「请填写账号名称」。
func validateChannelInput(req *channelRequest, mode string) error {
	return validateChannelInputFor(req, mode, 0)
}

/*
validateChannelInputFor 是 validateChannelInput 的带账号版本。

existingID > 0 时（更新已有账号），未传 model_bindings 的请求会用
**库里已存的绑定**参与校验 —— 否则「只改个备注」会因为请求体里没有
绑定表，而被判成「有模型未绑定」。
*/
func validateChannelInputFor(req *channelRequest, mode string, existingID int64) error {
	if name := strings.TrimSpace(req.Name); name != "" {
		if len([]rune(name)) > 128 {
			return errors.New("账号名称最长 128 个字符")
		}
	} else if mode == "create" {
		return errors.New("请填写账号名称")
	}

	if url := strings.TrimSpace(req.BaseURL); url != "" {
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			return errors.New("接口地址需以 http:// 或 https:// 开头")
		}
	} else if mode == "create" {
		return errors.New("请填写接口地址")
	}

	// 创建时必须给出凭据来源：要么手填密钥，要么走授权链路
	//（设备码一键绑定 / 订阅 OAuth 登录）—— 后两者的凭据由服务端写入，
	// 请求体里本来就没有密钥字段。
	if mode == "create" && strings.TrimSpace(req.APIKey) == "" {
		_, isLogin := services.UpstreamLoginVendorOfMethod(req.Method)
		if !services.DeviceMethodSupported(req.Method) && !isLogin {
			return errors.New("请填写上游密钥")
		}
	}
	if key := strings.TrimSpace(req.APIKey); key != "" {
		if strings.HasPrefix(key, "{") || strings.HasPrefix(key, "[") || services.IsDeviceCredentialMarker(key) {
			return errors.New("API Key 方式只接受正式签发的密钥，不接受 OAuth 凭据 JSON；订阅型账号请使用一键绑定")
		}
		if len(key) > 512 {
			return errors.New("上游密钥最长 512 字节")
		}
	}

	if req.Headers != nil {
		if err := validateHeaders(*req.Headers); err != nil {
			return err
		}
	}
	if req.ModelPaths != nil {
		if err := validateModelPaths(*req.ModelPaths); err != nil {
			return err
		}
	}
	/*
		必须至少指定一个支持的模型。

		models 为空在调度侧等于「不限模型」，看起来无害，实际是灾难：
		账号会被派去接它根本不支持的模型，用户拿到的是上游 400/404，
		而账号配置看起来完全正常。这个语义（空 = 不限）只对分组白名单成立，
		对单个账号不成立 —— 账号的能力边界必须显式写出来。

		创建时无条件要求；更新时只在「传了 models 字段」时校验 ——
		没传表示保持库里的原值，不该因为改个备注就卡住。
	*/
	if mode == "create" || req.Models != nil {
		normalized := normalizeModelList(req.Models)
		if len(normalized) == 0 {
			return errors.New("请至少添加一个支持的模型（可用「从上游获取模型列表」一键拉取）")
		}
		/*
			绑定的判定必须**带账号**：同一个 default-model 在不同上游是
			不同的模型，所以只有「该账号把它绑到了某个真实模型」才算数。
			这也是绑定与映射的分工 —— 绑定是账号声明身份（现在做），
			映射是全局路由别名（不做）。

			绑定从两处取：
			  · 本次请求带了 model_bindings（表单里刚选的）→ 用它；
			  · 没带（改备注之类的局部更新）→ 用库里已存的值，
			    否则会因为「库里已有绑定但请求里没有」而误报未绑定。

			公告与报错都要点名具体是哪些 —— 只说「有未绑定的模型」，
			管理员还得自己去猜是哪几个。
		*/
		bindings := map[string]string{}
		if req.ModelBindings != nil {
			bindings = services.ParseModelBindings(services.SerializeModelBindings(*req.ModelBindings))
		} else if existingID > 0 {
			if raw, err := loadChannelBindingsRaw(existingID); err == nil {
				bindings = services.ParseModelBindings(raw)
			}
		}
		if unresolved := services.UnresolvedAliasModelsFor(bindings, normalized); len(unresolved) > 0 {
			return errors.New("以下模型尚未绑定真实模型，请在本页「绑定真实模型」里逐个选择：" +
				strings.Join(unresolved, "、") +
				"（这些名字是上游自定义的别名，未经绑定会按 0 计费）")
		}
	}
	// 账号级高级配置（限流 / 计费口径 / 命名空间 / 备注 / 白名单 / 代理）。
	// 放在这里让创建与更新共用同一套规则。
	if err := validateChannelOptions(req); err != nil {
		return err
	}
	return nil
}

// validateModelPaths 校验「模型 → 路径」规则的格式。
//
// 格式错误的规则不会报错，只会静默失效 —— 结果是模型被发到错误的
// 协议端口，上游回一句 ModelProtocolUnsupported，
// 而配置看起来完全正常。所以在这里挡下来。
func validateModelPaths(raw string) error {
	for i, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		kind, patterns, found := strings.Cut(line, ":")
		kind = strings.TrimSpace(kind)
		if !found || kind == "" {
			return fmt.Errorf("第 %d 行格式不对，应为「协议: 模型模式」，如 messages: claude-*", i+1)
		}
		switch strings.ToLower(kind) {
		case "messages", "anthropic", "responses", "chat", "chat_completions", "openai", "systemone", "decision":
			// 认得的内置协议名
		default:
			if !strings.HasPrefix(kind, "/") {
				return fmt.Errorf("第 %d 行的协议「%s」无法识别，可用 messages / responses / chat，或直接写以 / 开头的路径", i+1, kind)
			}
		}
		if strings.TrimSpace(patterns) == "" {
			return fmt.Errorf("第 %d 行没有列出模型模式", i+1)
		}
	}
	return nil
}

// validateProxyURL 校验出口代理地址。
//
// 只允许 http / https / socks5 三种协议，且必须有主机名与端口：
// 代理是本账号所有上游流量的唯一出口，写错的后果是「整个账号不可用」，
// 因此在保存时挡下来，而不是等到第一次调用才炸。
func validateProxyURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return errors.New("代理地址格式不正确，示例：http://127.0.0.1:7890 或 socks5://host:1080")
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5":
	default:
		return errors.New("代理地址只支持 http / https / socks5 协议")
	}
	if u.User != nil {
		return errors.New("代理地址不支持携带用户名或密码")
	}
	if u.Port() == "" {
		return errors.New("代理地址必须带端口，示例：http://127.0.0.1:7890")
	}
	return nil
}

// applyBindingsSideEffects 为账号的每个绑定写入定价与能力参数。
//
// **为什么必须做**：绑定只存了「别名 → 真实模型」这一层对应关系，
// 而计费查的是 model_prices、请求形状靠的是能力参数。少了这一步，
// 绑定看起来成功了（保存不报错），但：
//
//	· 该模型的对外清单里不出现（AvailableModelsForGroup 要求 HasPrice）；
//	· 调用会按 0 计费（等于免费）。
//
// 绑定本身已经落库，所以这里失败只记日志、不让整个保存失败 ——
// 否则管理员会以为账号没保存成功而反复重试。
func applyBindingsSideEffects(bindings map[string]string) {
	for alias, realID := range bindings {
		if _, err := services.ApplyRealModel(alias, realID); err != nil {
			log.Printf("[channel] 为绑定 %s → %s 写入定价/能力失败: %v", alias, realID, err)
		}
	}
}

// ensureDeclaredRealModels 给账号直接声明的真实模型补上还没有的定价。
//
// 别名走绑定才会写价。模型本身已经是注册表里的 id 时，以前不会写价，
// 调用会因「未定价」被拒。已有价格不覆盖，避免冲掉管理员改过的单价。
func ensureDeclaredRealModels(models []string) {
	for _, model := range models {
		real, ok := services.LookupRealModel(model)
		if !ok {
			continue
		}
		if _, exists := services.PriceOf(real.ID); exists {
			continue
		}
		if _, err := services.ApplyRealModel(model, real.ID); err != nil {
			log.Printf("[channel] 为真实模型 %s 写入定价/能力失败: %v", real.ID, err)
		}
	}
}

// requestBindingsRaw 把请求里的绑定表序列化成存库的 JSON。
//
// 没传（nil）返回空串：调用方只在「传了」的时候才把它写进 updates，
// 所以空串不会覆盖库里已有的值。
func requestBindingsRaw(bindings *map[string]string) string {
	if bindings == nil {
		return ""
	}
	return services.SerializeModelBindings(*bindings)
}

// loadChannelBindingsRaw 读取某个账号已存的绑定（原始 JSON 文本）。
//
// 校验时要拿它来判断「请求没带绑定表时，库里已有的绑定算不算数」。
func loadChannelBindingsRaw(channelID int64) (string, error) {
	if channelID <= 0 {
		return "", errors.New("账号 ID 无效")
	}
	var raw sql.NullString
	err := db.DB.QueryRow(
		`SELECT COALESCE(model_bindings, '') FROM channels WHERE id = ?`, channelID,
	).Scan(&raw)
	if err != nil {
		return "", err
	}
	if !raw.Valid {
		return "", nil
	}
	return raw.String, nil
}

// normalizeModelPaths 统一换行并去掉首尾空白。
func normalizeModelPaths(raw *string) string {
	if raw == nil {
		return ""
	}
	value := strings.ReplaceAll(*raw, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.TrimSpace(value)
}

// validateHeaders 校验自定义请求头的格式。
//
// 格式错误的头不会报错，只会静默失效 —— 上游收到一个名字奇怪的头，
// 然后返回「缺少 xxx」这种毫不相干的错误。所以在这里挡下来。
func validateHeaders(raw string) error {
	for i, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, _, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(key) == "" {
			return fmt.Errorf("第 %d 行请求头格式不对，应为「名称: 值」", i+1)
		}
		if strings.ContainsAny(key, " \t") {
			return fmt.Errorf("第 %d 行请求头名称不能含空格", i+1)
		}
		if strings.EqualFold(strings.TrimSpace(key), "authorization") ||
			strings.EqualFold(strings.TrimSpace(key), "content-type") {
			return fmt.Errorf("第 %d 行：Authorization 与 Content-Type 由系统设置，不要在此重复", i+1)
		}
	}
	return nil
}

// normalizeHeaders 统一成 LF 换行并去掉首尾空白。
// Windows 上粘贴进来的内容常带 CR，留着会让值末尾多一个不可见字符。
func normalizeHeaders(raw *string) string {
	if raw == nil {
		return ""
	}
	value := strings.ReplaceAll(*raw, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	return strings.TrimSpace(value)
}

func channelByID(id int64) (*Channel, error) {
	row := db.DB.QueryRow(
		`SELECT `+channelColumns+`
		 FROM channels WHERE id = ?`, id,
	)
	return scanChannel(row)
}

func scanChannel(s interface{ Scan(...any) error }) (*Channel, error) {
	var (
		ch          Channel
		apiKey      sql.NullString
		models      sql.NullString
		lastTest    sql.NullString
		cooldown    sql.NullString
		createdAt   string
		bindingsRaw string
	)
	/*
		扫描的目标数量必须与 channelColumns 里的列数**严格一致**
		（当前 33 列 = channelColumnCount）。

		这是踩过的坑：加了列却漏改这里，Scan 直接报
		「expected N destination arguments in Scan, not M」，
		而 scanChannel 的错误在当前调用点被当成「跳过这一行」处理 ——
		结果账号列表整个变空，接口还是 200，看起来像「一个账号都没有」。
		加列时请同时改 channelColumns、channelColumnCount 与这里；
		channel_options_test.go 里有针对这三者同步的断言
		（含一个直接数 Scan 目标的假扫描器用例，编译期之外还能挡住漂移）。
	*/
	if err := s.Scan(
		&ch.ID, &ch.Name, &ch.Vendor, &ch.BaseURL, &apiKey, &models, &ch.GroupName,
		&ch.Headers, &ch.ModelPaths,
		&ch.ContextBilling, &ch.Namespace, &ch.Remark, &ch.RequireCaller, &ch.ProxyURL,
		&ch.TLSFingerprint, &bindingsRaw,
		&ch.Priority, &ch.Weight, &ch.Concurrency, &ch.MinGapMs, &ch.MaxPerMin,
		&ch.Status, &ch.DisabledBy, &ch.StatusNote,
		&ch.ResponseMs, &ch.TTFTMs, &ch.UsedCount, &ch.LastError,
		&lastTest, &cooldown, &createdAt, &ch.Method, &ch.HasCredential, &ch.AuthExpiresAt,
	); err != nil {
		return nil, err
	}
	ch.ModelBindings = services.ParseModelBindings(bindingsRaw)

	// 密钥只回「是否已配置」与末四位，绝不回明文。
	// 设备授权渠道的 api_key 是内部标识（ooapi-*-channel-{id}），不是密钥，
	// 不能当作「已配置密钥」展示给前端。
	plainKey := ""
	if apiKey.Valid {
		plainKey = services.OpenChannelAPIKey(apiKey.String)
	}
	if plainKey != "" && !services.IsDeviceCredentialMarker(plainKey) {
		ch.HasKey = true
		ch.KeyHint = keyHint(plainKey)
	}
	if ch.Method == "api" {
		ch.HasCredential = ch.HasKey
	}
	// 订阅渠道的凭据在 auth_credential 里（加密），api_key 只是内部标识。
	// has_credential 由扫描列给出；这里把提示语统一成「已加密」，
	// 避免把内部标识当成密钥末四位展示。
	if _, isLogin := services.UpstreamLoginVendorOfMethod(ch.Method); isLogin && ch.HasCredential {
		ch.KeyHint = "账号凭据已加密"
	}
	if ch.Method != "api" && ch.HasCredential && ch.KeyHint == "" {
		ch.KeyHint = "账号凭据已加密"
	}
	ch.Models = splitModelList(models.String)
	if lastTest.Valid {
		ch.LastTestAt = lastTest.String
	}
	if cooldown.Valid {
		ch.CooldownTo = cooldown.String
	}
	ch.CreatedAt = createdAt
	return &ch, nil
}

// keyHint 取密钥末四位作为提示。多 key（换行分隔）时只提示第一把。
func keyHint(raw string) string {
	first := strings.TrimSpace(strings.Split(raw, "\n")[0])
	if len(first) <= 4 {
		return "****"
	}
	return "****" + first[len(first)-4:]
}

// deviceProbeModel 是设备授权渠道的默认探测模型（渠道未填模型列表时用）。
func deviceProbeModel(method string) string {
	switch method {
	case "kiro":
		return "claude-sonnet-4.5"
	case "workbuddy":
		return "glm-5.3"
	case "grok":
		return "grok-4.5"
	case services.LoginVendorCodex:
		// Codex 背后的账号级可用模型因订阅档位而异，找不到时上游会给 400
		// 「model not found」。这两个名字在不同档位里都存在度较高。
		return "gpt-5"
	case services.LoginVendorClaudeOAuth:
		return "claude-haiku-4.5"
	case services.LoginVendorAntigravity:
		return "gemini-2.5-flash"
	}
	return ""
}

// probePathForMethod 返回连通性测试要打的上游路径。
//
// 默认 /chat/completions（所有 OpenAI 兼容上游的通用端点）；
// 订阅渠道的上游端点由各自协议决定。
func probePathForMethod(method string) string {
	switch method {
	case services.LoginVendorCodex:
		return "/responses"
	case services.LoginVendorClaudeOAuth:
		return "/messages"
	}
	return "/chat/completions"
}

func firstModel(modelsRaw string) string {
	parts := strings.Split(modelsRaw, ",")
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			return v
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// applyCustomHeaders 把账号配置的额外请求头加到请求上。
//
// 与网关转发用的是同一套规则（含 {{session}} 占位符），
// 否则「测试通过、正式调用失败」这种最难查的问题就会冒出来。
func applyCustomHeaders(req *http.Request, raw string) {
	for _, h := range services.ParseChannelHeaders(raw) {
		value := h.Value
		if strings.Contains(value, "{{session}}") {
			value = strings.ReplaceAll(value, "{{session}}", randomSessionID())
		}
		req.Header.Set(h.Key, value)
	}
}

// randomSessionID 生成上游要求的会话标识。
func randomSessionID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("ses%d", time.Now().UnixNano())
	}
	return "ses_" + hex.EncodeToString(buf)
}

// optionalGroupName 解引用可选的账号分组名（未传 = 空 = 所有分组）。
func optionalGroupName(v *string) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(*v)
}
