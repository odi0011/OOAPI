package handlers

/*
订阅账号（Codex / Claude / Google Antigravity）的交互式登录接口。

流程：
  1. 管理端点「一键登录」→ POST /devices/login/start  {vendor}
     服务端生成授权地址（含 state 与 PKCE），返回给前端打开。
  2. 用户在官方页面完成授权，浏览器跳到 localhost（打不开，属正常现象），
     把地址栏那串 URL 复制回来。
  3. POST /devices/login/exchange  {vendor, input}
     服务端校验 state（必须是自己发起的、未过期的），换取并加密保存凭据。

凭据只在服务端流动：换回来的密文交给随后的「创建账号 / 重新授权」写入渠道，
响应里永远只有账号标签（邮箱之类）。
*/

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// 客户端 UA 与传输层共用同一份常量（claude / antigravity 的已在各自传输文件里定义，
// 这里只补 Codex 的），避免出现「传输层能过、拉模型被拒」的漂移。
const codexCLIUserAgent = "codex_cli_rs/0.1.0"

// loginLoginMethodForVendor 校验厂商是否是支持的订阅登录方式。
func loginMethodForVendor(vendor string) (string, bool) {
	return services.UpstreamLoginVendorOfMethod(vendor)
}

// loginVendorLabel 是审计与提示用的中文名。
func loginVendorLabel(vendor string) string {
	switch vendor {
	case services.LoginVendorCodex:
		return "Codex 订阅"
	case services.LoginVendorClaudeOAuth:
		return "Claude 订阅"
	case services.LoginVendorAntigravity:
		return "Google 订阅"
	}
	return vendor
}

// AdminUpstreamLoginStart 生成授权地址，需要 channel:edit。
func AdminUpstreamLoginStart(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Vendor string `json:"vendor"`
	}
	if c.ShouldBindJSON(&req) != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	vendor, okVendor := loginMethodForVendor(req.Vendor)
	if !okVendor {
		fail(c, http.StatusBadRequest, "该接入方式不支持交互式登录，请使用「粘贴凭据」", "unsupported_vendor")
		return
	}
	start, err := services.UpstreamLogins.Start(vendor, owner)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "login_start_failed")
		return
	}
	ok(c, start)
}

// AdminUpstreamLoginExchange 用粘贴回来的回调地址换取凭据。
//
// 返回的是**一次性登录凭据句柄**而不是明文：密文本身交给服务端暂存，
// 前端拿到的 ticket 只能用于随后的「创建账号 / 重新授权」。
func AdminUpstreamLoginExchange(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Vendor string `json:"vendor"`
		Input  string `json:"input"`
	}
	if c.ShouldBindJSON(&req) != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	vendor, okVendor := loginMethodForVendor(req.Vendor)
	if !okVendor {
		fail(c, http.StatusBadRequest, "该接入方式不支持交互式登录", "unsupported_vendor")
		return
	}
	if strings.TrimSpace(req.Input) == "" {
		fail(c, http.StatusBadRequest, "请把浏览器地址栏里的完整回调地址粘贴进来", "empty_input")
		return
	}
	credential, err := services.UpstreamLogins.Exchange(c.Request.Context(), vendor, owner, req.Input)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "login_exchange_failed")
		return
	}
	// 凭据密文交给票据表暂存，前端只拿句柄。
	ticket := services.StoreLoginCredential(owner, credential)
	auditLog(c, "订阅账号授权成功", loginVendorLabel(vendor)+" "+credential.AccountLabel)
	ok(c, gin.H{
		"ticket":     ticket,
		"vendor":     credential.Vendor,
		"account":    credential.AccountLabel,
		"expires_in": credential.ExpiresAt,
	})
}

// AdminUpstreamLoginImport 导入粘贴的凭据（官方 CLI / CPA / sub2api 导出）。
//
// 与交互式登录并列的第二条入口：用户手里已经有用别的工具登录出来的凭据文件时，
// 不必重新走一遍授权。产出同样是一次性句柄，后续创建 / 重新授权完全一致。
func AdminUpstreamLoginImport(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Vendor string `json:"vendor"`
		Input  string `json:"input"`
	}
	if c.ShouldBindJSON(&req) != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	vendor, okVendor := loginMethodForVendor(req.Vendor)
	if !okVendor {
		fail(c, http.StatusBadRequest, "该接入方式不支持粘贴凭据导入", "unsupported_vendor")
		return
	}
	credential, err := services.ImportLoginCredential(vendor, req.Input)
	if err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "import_failed")
		return
	}
	ticket := services.StoreLoginCredential(owner, credential)
	auditLog(c, "导入订阅账号凭据", loginVendorLabel(vendor)+" "+credential.AccountLabel)
	ok(c, gin.H{
		"ticket":     ticket,
		"vendor":     credential.Vendor,
		"account":    credential.AccountLabel,
		"expires_in": credential.ExpiresAt,
	})
}

// AdminUpstreamLoginModels 用刚换到的凭据直接拉模型清单（账号还没落库时用）。
//
// 与设备授权的 /devices/models 同一思路：模型是保存的必需项，
// 让用户先存一个没有模型的账号再回头拉，会死锁在置灰的保存按钮上。
func AdminUpstreamLoginModels(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Ticket string `json:"ticket"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Ticket) == "" {
		fail(c, http.StatusBadRequest, "缺少授权凭据", "bad_request")
		return
	}
	credential, okTicket := services.TakeLoginCredential(owner, req.Ticket)
	if !okTicket {
		fail(c, http.StatusBadRequest, "授权凭据已过期，请重新授权", "ticket_expired")
		return
	}
	models, err := fetchLoginModelsWithCredential(c.Request.Context(), credential)
	if err != nil {
		// 拉取失败不消耗凭据：用户可以修正后重试，或直接保存后再拉。
		services.RestoreLoginCredential(owner, req.Ticket, credential)
		fail(c, http.StatusBadGateway, "获取模型失败："+err.Error(), "fetch_failed")
		return
	}
	services.RestoreLoginCredential(owner, req.Ticket, credential)
	if len(models) == 0 {
		fail(c, http.StatusBadGateway, "上游未返回任何模型", "no_models")
		return
	}
	ok(c, gin.H{"models": models, "count": len(models)})
}

// fetchLoginModelsWithCredential 用暂存的加密凭据直接拉模型清单。
//
// 与设备授权的 fetchDeviceModelsWithTicket 同一思路：账号还没落库，
// 不能走「按渠道 ID 解析凭据」的常规通道，只能就地解密再请求。
func fetchLoginModelsWithCredential(ctx context.Context, credential services.UpstreamLoginCredential) ([]string, error) {
	switch credential.Vendor {
	case services.LoginVendorCodex:
		cred, err := services.DecryptCodexCredential(credential.Encrypted)
		if err != nil {
			return nil, err
		}
		raw, err := fetchJSONWithHeaders(ctx, "https://chatgpt.com/backend-api/codex/models", cred.AccessToken, codexModelHeaders(cred))
		if err != nil {
			return nil, err
		}
		return parseOpenAIModelList(raw)

	case services.LoginVendorClaudeOAuth:
		cred, err := services.DecryptClaudeOAuthCredential(credential.Encrypted)
		if err != nil {
			return nil, err
		}
		// 拉模型用单个 beta（与传输层一致）：多带其它 beta 会被上游当成
		// API Key 请求而 401。
		raw, err := fetchJSONWithHeaders(ctx, "https://api.anthropic.com/v1/models?limit=100", cred.AccessToken, map[string]string{
			"anthropic-version": "2023-06-01",
			"anthropic-beta":    "oauth-2025-04-20",
			"x-app":             "cli",
			"User-Agent":        claudeCLIUserAgent,
		})
		if err != nil {
			return nil, err
		}
		return parseOpenAIModelList(raw)

	case services.LoginVendorAntigravity:
		cred, err := services.DecryptAntigravityCredential(credential.Encrypted)
		if err != nil {
			return nil, err
		}
		project, err := services.AntigravityProjectFor(ctx, 0, cred)
		if err != nil {
			return nil, err
		}
		body, _ := json.Marshal(map[string]any{"project": project})
		raw, err := fetchJSONPost(ctx, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", cred.AccessToken, body, map[string]string{
			"User-Agent": antigravityCLIUserAgent,
		})
		if err != nil {
			return nil, err
		}
		var parsed struct {
			Models map[string]json.RawMessage `json:"models"`
		}
		if json.Unmarshal(raw, &parsed) != nil {
			return nil, errors.New("Google 模型列表不是合法 JSON")
		}
		ids := []string{}
		for id := range parsed.Models {
			if strings.HasPrefix(id, "chat_") || strings.HasPrefix(id, "tab_") {
				continue
			}
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return ids, nil
	}
	return nil, errors.New("未知的订阅厂商标识")
}

// codexModelHeaders 是 Codex 拉模型要带的身份头（与传输层保持一致）。
func codexModelHeaders(cred services.CodexCredential) map[string]string {
	header := map[string]string{
		"Originator": "codex_cli_rs",
		"User-Agent": codexCLIUserAgent,
	}
	if cred.AccountID != "" {
		header["Chatgpt-Account-Id"] = cred.AccountID
	}
	return header
}

// fetchJSONWithHeaders 带 Bearer 的 GET（订阅渠道拉模型用）。
func fetchJSONWithHeaders(ctx context.Context, target, token string, header map[string]string) ([]byte, error) {
	return fetchJSON(ctx, target, token, header)
}

// fetchJSONPost 带 Bearer 的 JSON POST（Google 的私有端点只收 POST）。
func fetchJSONPost(ctx context.Context, target, token string, body []byte, header map[string]string) ([]byte, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, target, strings.NewReader(string(body)))
	if err != nil {
		return nil, errors.New("构造请求失败")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Authorization", "Bearer "+token)
	for key, value := range header {
		req.Header.Set(key, value)
	}
	resp, err := upstreamClient.Do(req)
	if err != nil {
		return nil, errors.New("无法连接上游：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("登录已过期，请重新一键登录（上游返回 HTTP %d）", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("上游返回 %d：%s", resp.StatusCode, truncate(string(raw), 160))
	}
	return raw, nil
}

/* ---------- 渠道创建 / 重新授权 ---------- */

/*
订阅渠道的创建与设备授权渠道同构：
  · 必须在服务端校验厂商与接入方式的搭配（错配会把 A 的凭据发给 B）；
  · 地址由服务端按方式推导，管理员改不了；
  · 凭据从一次性句柄里取，不从请求体取（请求体里根本没有凭据字段）。

与设备授权的差别：这里的凭据在「拉模型」时可能已经被消费过一次，
所以创建时要重新取一份 —— 这是 TakeLoginCredentialForChannel 存在的原因。
*/

// createLoginChannel 用登录凭据句柄创建订阅渠道。
func createLoginChannel(c *gin.Context, req *channelRequest) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	vendor, isLogin := services.UpstreamLoginVendorOfMethod(req.Method)
	if !isLogin {
		fail(c, 400, "该接入方式不支持订阅登录渠道", "invalid_input")
		return
	}
	// 票据必须传入且是本次登录产生的。
	if strings.TrimSpace(req.Ticket) == "" {
		fail(c, 400, "订阅渠道必须通过一键登录创建，请先完成授权", "invalid_credential")
		return
	}
	credential, okCredential := services.TakeLoginCredentialForChannel(owner, req.Ticket, false)
	if !okCredential {
		fail(c, 400, "授权凭据已过期，请重新登录", "credential_expired")
		return
	}
	if credential.Vendor != vendor {
		fail(c, 400, "授权凭据与所选接入方式不一致", "vendor_mismatch")
		return
	}
	// 厂商必须与方法匹配（codex→openai / claude-oauth→anthropic / antigravity→gemini）。
	expectVendor := services.UpstreamVendorForLoginMethod(vendor)
	if got := strings.TrimSpace(req.Vendor); got != "" && got != expectVendor {
		fail(c, 400, "该接入方式必须搭配 "+expectVendor+" 厂商", "vendor_mismatch")
		return
	}
	// 凭据里的解密动作先做一次：格式坏了就没必要建渠道。
	if _, err := decryptLoginCredential(credential); err != nil {
		fail(c, 400, err.Error(), "invalid_credential")
		return
	}
	if req.ModelPaths != nil && strings.TrimSpace(*req.ModelPaths) != "" {
		fail(c, 400, "订阅渠道使用固定上游协议，不支持自定义协议路径", "invalid_input")
		return
	}
	/*
		不接受手填 API Key。

		这条不是多余的校验：订阅渠道的凭据是登录换来的加密凭据，如果放行一个
		api_key，账号会同时存在两份互相矛盾的凭据 —— 传输层永远用登录凭据，
		而管理员以为自己在用刚填的那把密钥，排查时两边都说不出问题在哪。
		要填密钥请建普通的 API 账号。
	*/
	if strings.TrimSpace(req.APIKey) != "" {
		fail(c, 400, "订阅渠道的凭据由一键登录产生，不接受手填的 API Key", "invalid_credential")
		return
	}
	base := services.LoginChannelBase(vendor)
	if userBase := strings.TrimSpace(req.BaseURL); userBase != "" && strings.TrimRight(userBase, "/") != base {
		fail(c, 400, "订阅渠道的接口地址由服务端按接入方式推导，不能自定义", "invalid_url")
		return
	}
	staged := *req
	staged.BaseURL = "https://placeholder.invalid"
	staged.Vendor = expectVendor
	if err := validateChannelInput(&staged, "create"); err != nil {
		fail(c, 400, err.Error(), "invalid_input")
		return
	}
	status, priority, weight := 1, 0, 1
	if req.Status != nil {
		status = *req.Status
	}
	if req.Priority != nil {
		priority = *req.Priority
	}
	if req.Weight != nil {
		weight = *req.Weight
	}
	if (status != 0 && status != 1) || weight < 1 {
		fail(c, 400, "状态或权重不正确", "invalid_input")
		return
	}

	result, err := exec(
		`INSERT INTO channels (name, vendor, method, base_url, api_key, auth_credential, auth_expires_at, auth_version,
		                       models, group_name, headers, model_paths, priority, weight, status,
		                       context_billing, namespace, remark, require_caller, proxy_url, tls_fingerprint,
		                       concurrency, min_gap_ms, max_per_min)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		strings.TrimSpace(req.Name), expectVendor, vendor, base,
		services.LoginCredentialMarker(vendor, 0), credential.Encrypted, credential.ExpiresAt,
		strings.Join(normalizeModelList(req.Models), ","), optionalGroupName(req.GroupName),
		normalizeHeaders(req.Headers), priority, weight, status,
		optionString(req.ContextBilling, "auto"), optionString(req.Namespace, ""), optionString(req.Remark, ""),
		optionString(req.RequireCaller, ""), optionString(req.ProxyURL, ""), optionString(req.TLSFingerprint, ""),
		optionInt(req.Concurrency), optionInt(req.MinGapMs), optionInt(req.MaxPerMin),
	)
	if err != nil {
		log.Printf("[channel] 创建订阅渠道失败: %v", err)
		fail(c, http.StatusInternalServerError, "创建账号失败", "server_error")
		return
	}
	id, _ := result.LastInsertId()
	// api_key 里的内部标识要带渠道 ID，插入后回填（与设备授权同一步）。
	if _, err := exec("UPDATE channels SET api_key = ? WHERE id = ?", services.LoginCredentialMarker(vendor, id), id); err != nil {
		log.Printf("[channel] 回填订阅渠道标识失败: %v", err)
	}
	// 到这里凭据已经落库，句柄可以消费掉了。
	services.TakeLoginCredentialForChannel(owner, req.Ticket, true)
	services.MarkChannelsDirty()
	auditLog(c, "创建订阅账号", loginVendorLabel(vendor)+" "+strings.TrimSpace(req.Name))
	ch, err := channelByID(id)
	if err != nil {
		ok(c, gin.H{"id": id, "vendor": expectVendor, "method": vendor, "has_credential": true})
		return
	}
	ok(c, ch)
}

// relinkLoginChannel 用新的登录凭据刷新一个已存在订阅渠道的凭据（重新授权）。
func relinkLoginChannel(c *gin.Context, existing *Channel, req *channelRequest) bool {
	if strings.TrimSpace(req.Ticket) == "" {
		return false
	}
	owner, found := deviceOwner(c)
	if !found {
		return true
	}
	credential, okCredential := services.TakeLoginCredentialForChannel(owner, req.Ticket, false)
	if !okCredential {
		fail(c, 400, "授权凭据已过期，请重新登录", "credential_expired")
		return true
	}
	if credential.Vendor != existing.Method {
		fail(c, 400, "授权凭据与账号的接入方式不一致", "vendor_mismatch")
		return true
	}
	if _, err := decryptLoginCredential(credential); err != nil {
		fail(c, 400, err.Error(), "invalid_credential")
		return true
	}
	if _, err := exec(
		`UPDATE channels SET auth_credential = ?, auth_expires_at = ?, auth_version = auth_version + 1,
		                    base_url = ?, api_key = ?, last_error = '', cooldown_until = NULL
		 WHERE id = ?`,
		credential.Encrypted, credential.ExpiresAt, services.LoginChannelBase(credential.Vendor),
		services.LoginCredentialMarker(credential.Vendor, existing.ID), existing.ID,
	); err != nil {
		log.Printf("[channel] 重新授权失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存授权凭据失败", "server_error")
		return true
	}
	services.TakeLoginCredentialForChannel(owner, req.Ticket, true)
	// 句柄已经消费掉，从这里开始这一轮请求不再携带票据 —— 调用方随后还有
	// 「带票据的更新一律拒绝」的判断（防止用票据偷换接入方式），
	// 不清掉就会被自己的保护逻辑挡住。
	req.Ticket = ""
	auditLog(c, "重新授权订阅账号", loginVendorLabel(credential.Vendor)+" "+existing.Name)
	return false
}

// decryptLoginCredential 校验凭据能解开（按厂商分派）。
func decryptLoginCredential(credential services.UpstreamLoginCredential) (any, error) {
	switch credential.Vendor {
	case services.LoginVendorCodex:
		return services.DecryptCodexCredential(credential.Encrypted)
	case services.LoginVendorClaudeOAuth:
		return services.DecryptClaudeOAuthCredential(credential.Encrypted)
	case services.LoginVendorAntigravity:
		return services.DecryptAntigravityCredential(credential.Encrypted)
	}
	return nil, errors.New("未知的订阅厂商标识")
}

// optionString / optionInt 把可选字段解引用，未提供时用默认值。
func optionString(v *string, fallback string) string {
	if v == nil {
		return fallback
	}
	return strings.TrimSpace(*v)
}

func optionInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
