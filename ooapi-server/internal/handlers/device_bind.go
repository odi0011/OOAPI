package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// deviceVendorMethods 是一键绑定支持的「厂商 → 接入方式」映射。
// 四个厂商共用同一套会话/票据引擎（services.DeviceBindings）。
var deviceVendorMethods = map[string]string{
	"kiro":      "kiro",
	"workbuddy": "workbuddy",
	"cline":     "cli",
	"grok":      "grok",
}

// deviceVendorLabel 返回厂商的展示名（审计日志与面板文案用）。
func deviceVendorLabel(vendor string) string {
	switch services.NormalizeDeviceVendor(vendor) {
	case "kiro":
		return "Kiro"
	case "workbuddy":
		return "WorkBuddy"
	case "cline":
		return "Cline"
	case "grok":
		return "Grok"
	}
	return vendor
}

// AdminDeviceModels 用一张未消费的授权票据直接拉取上游模型清单。
//
// 为什么需要它：一键授权成功后，账号往往还没保存（新建流程），
// 此时渠道表里没有这行记录，按渠道 ID 解析凭据的常规通道用不了。
// 但「授权成功就该立刻拿到全部模型」是产品要求 —— 让用户先存一个
// 没有模型的账号、再回来点「获取模型」，等于把必要的步骤推给用户，
// 而模型清单又是保存的必需项，会死锁。
//
// 票据只读不消费：拉模型是只读操作，票据要留给随后的「创建账号」。
func AdminDeviceModels(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Ticket string `json:"ticket"`
		Vendor string `json:"vendor"`
	}
	if c.ShouldBindJSON(&req) != nil || strings.TrimSpace(req.Ticket) == "" {
		fail(c, http.StatusBadRequest, "缺少授权票据", "bad_request")
		return
	}
	ticket, okTicket := services.DeviceBindings.PreviewTicket(owner, req.Ticket)
	if !okTicket {
		fail(c, http.StatusBadRequest, "授权凭据已过期，请重新授权", "ticket_expired")
		return
	}
	vendor := services.NormalizeDeviceVendor(ticket.Vendor)
	if vendor == "" {
		fail(c, http.StatusBadRequest, "授权凭据的厂商不正确", "invalid_credential")
		return
	}
	if want := services.NormalizeDeviceVendor(req.Vendor); want != "" && want != vendor {
		fail(c, http.StatusBadRequest, "授权票据与所选厂商不一致", "vendor_mismatch")
		return
	}

	models, err := fetchDeviceModelsWithTicket(c.Request.Context(), vendor, ticket.Encrypted)
	if err != nil {
		fail(c, http.StatusBadGateway, "获取模型失败："+err.Error(), "fetch_failed")
		return
	}
	if len(models) == 0 {
		fail(c, http.StatusBadGateway, "上游未返回任何模型", "no_models")
		return
	}
	auditLog(c, "一键授权后自动获取模型", deviceVendorLabel(vendor)+" 共 "+strconv.Itoa(len(models))+" 个")
	ok(c, gin.H{"models": models, "count": len(models)})
}

// fetchDeviceModelsWithTicket 按票据里的加密凭据请求上游模型清单。
//
// 与运行期通道的差别只有「凭据从哪来」：这里不查渠道表，直接用票据里的
// 密文解密，所以凭证还没落库也能拉。请求本身仍走同一套共享客户端，
// 各厂商的 transport 装饰器照常生效（它们按渠道 ID 解析凭据 ——
// 所以这里必须显式构造请求，不能借道带内部标识的路径）。
func fetchDeviceModelsWithTicket(ctx context.Context, vendor, encrypted string) ([]string, error) {
	switch vendor {
	case "kiro":
		cred, err := services.DecryptKiroCredential(encrypted)
		if err != nil {
			return nil, err
		}
		raw, err := fetchJSON(ctx, services.KiroAPIBaseURL(cred.Region)+"/ListAvailableModels?origin=AI_EDITOR&maxResults=50", cred.AccessToken, map[string]string{
			"User-Agent":                  "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
			"X-Amz-User-Agent":            "aws-sdk-js/1.0.0 KiroIDE-0.8.0",
			"X-Amzn-Codewhisperer-Optout": "true",
		})
		if err != nil {
			return nil, err
		}
		return parseKiroModels(raw)

	case "workbuddy":
		cred, err := services.DecryptWorkBuddyCredential(encrypted)
		if err != nil {
			return nil, err
		}
		apiBase, webHost, locale := services.WorkBuddyRealmHosts(cred.Realm)
		header := map[string]string{
			"Accept-Language":     locale,
			"X-Requested-With":    "XMLHttpRequest",
			"X-Codebuddy-Request": "1",
			"X-Domain":            webHost,
			"X-Product":           "SaaS",
			"X-Ide-Type":          "CLI",
			"X-Ide-Name":          "CLI",
			"Origin":              "https://" + webHost,
			"Referer":             "https://" + webHost + "/",
		}
		if cred.UserID != "" {
			header["X-User-Id"] = cred.UserID
		}
		if cred.EnterpriseID != "" {
			header["X-Enterprise-Id"] = cred.EnterpriseID
		} else {
			header["X-No-Enterprise-Id"] = "true"
		}
		raw, err := fetchJSON(ctx, strings.TrimRight(apiBase, "/")+"/v3/config", cred.AccessToken, header)
		if err != nil {
			return nil, err
		}
		return parseWorkBuddyModels(raw)

	case "grok":
		cred, err := services.DecryptGrokCredential(encrypted)
		if err != nil {
			return nil, err
		}
		raw, err := fetchJSON(ctx, services.GrokChannelBaseURL()+"/models", cred.AccessToken, map[string]string{
			"User-Agent": services.GrokUserAgent(),
		})
		if err != nil {
			return nil, err
		}
		return parseOpenAIModelList(raw)

	case "cline":
		cred, err := services.DecryptClineCredential(encrypted)
		if err != nil {
			return nil, err
		}
		raw, err := fetchJSON(ctx, services.ClineAPIBase+"/models", cred.AccessToken, nil)
		if err != nil {
			return nil, err
		}
		return parseOpenAIModelList(raw)
	}
	return nil, errors.New("未知的设备授权厂商")
}

// fetchJSON 发一次带 Bearer 的 GET，返回响应体（2xx 之外报错并带上游片段）。
func fetchJSON(ctx context.Context, target, token string, header map[string]string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, errors.New("构造请求失败")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	resp, err := upstreamClient.Do(req)
	if err != nil {
		return nil, errors.New("无法连接上游：" + err.Error())
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("登录已过期，请重新一键授权（上游返回 HTTP %d）", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("上游返回 %d：%s", resp.StatusCode, truncate(string(raw), 160))
	}
	return raw, nil
}

// parseOpenAIModelList 解析 OpenAI 形状的 {"data":[{"id":...}]} 模型列表。
func parseOpenAIModelList(raw []byte) ([]string, error) {
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, errors.New("响应格式无法解析")
	}
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
	return out, nil
}

func AdminDeviceVendors(c *gin.Context) {
	ok(c, gin.H{
		"vendors": []string{"kiro", "workbuddy", "cline", "grok"},
		"methods": []string{"kiro", "workbuddy", "cli", "grok"},
		"unavailable": gin.H{
			"qoder": services.DeviceUnavailable("qoder"),
		},
	})
}
func deviceOwner(c *gin.Context) (int64, bool) {
	user, found := currentUser(c)
	if !found {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return 0, false
	}
	return user.ID, true
}

// validateDeviceTarget 校验目标渠道：不存在的 0（新建）永远放行；已有渠道必须
// 是与本次授权相同厂商/方式的设备授权渠道，不能覆盖 API Key 渠道。
func validateDeviceTarget(ctx context.Context, id int64, vendor string) error {
	if id == 0 {
		return nil
	}
	if id < 0 {
		return errors.New("目标渠道 ID 不正确")
	}
	var channelVendor, method string
	if db.DB.QueryRowContext(ctx, "SELECT vendor, method FROM channels WHERE id = ?", id).Scan(&channelVendor, &method) != nil {
		return errors.New("目标渠道不存在")
	}
	wantMethod, ok := deviceVendorMethods[services.NormalizeDeviceVendor(vendor)]
	if !ok || channelVendor != services.NormalizeDeviceVendor(vendor) || method != wantMethod {
		return errors.New("绑定只能写入同厂商的设备授权渠道，不可覆盖其它厂商或 API Key 方式")
	}
	return nil
}

func AdminDeviceStart(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Vendor    string `json:"vendor"`
		Method    string `json:"method"`
		Region    string `json:"region"`
		StartURL  string `json:"start_url"`
		Realm     string `json:"realm"`
		ChannelID int64  `json:"channel_id"`
	}
	if c.ShouldBindJSON(&req) != nil {
		fail(c, 400, "请求格式不正确", "bad_request")
		return
	}
	vendor := services.NormalizeDeviceVendor(req.Vendor)
	if err := services.ValidateDeviceVendor(vendor, strings.TrimSpace(req.Method)); err != nil {
		fail(c, 400, err.Error(), "device_unavailable")
		return
	}
	if err := validateDeviceTarget(c.Request.Context(), req.ChannelID, vendor); err != nil {
		fail(c, 400, err.Error(), "bind_target_mismatch")
		return
	}
	out, err := services.DeviceBindings.Start(c.Request.Context(), owner, req.ChannelID, services.DeviceStartRequest{
		Vendor: vendor, Method: strings.TrimSpace(req.Method), Region: req.Region, StartURL: req.StartURL, Realm: req.Realm,
	})
	if err != nil {
		fail(c, 502, err.Error(), "device_start_failed")
		return
	}
	auditLog(c, "发起设备授权", deviceVendorLabel(vendor)+" "+out.Method)
	ok(c, out)
}

func AdminDevicePoll(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		SessionID string `json:"session_id"`
		Vendor    string `json:"vendor"`
		ChannelID int64  `json:"channel_id"`
	}
	if c.ShouldBindJSON(&req) != nil || req.SessionID == "" {
		fail(c, 400, "缺少会话标识", "bad_request")
		return
	}
	// 前端 poll 时可能不带 vendor：以服务端会话为准（不可信调用方）。
	vendor := services.NormalizeDeviceVendor(req.Vendor)
	if vendor == "" {
		vendor = services.DeviceBindings.SessionVendor(owner, req.SessionID)
	}
	// 会话已失效时 vendor 无法判定：跳过目标校验，让 Poll 返回 expired 终态。
	if vendor != "" {
		if err := validateDeviceTarget(c.Request.Context(), req.ChannelID, vendor); err != nil {
			fail(c, 400, err.Error(), "bind_target_mismatch")
			return
		}
	}
	out, err := services.DeviceBindings.Poll(c.Request.Context(), owner, req.SessionID, req.ChannelID)
	if err != nil {
		fail(c, 502, err.Error(), "device_poll_failed")
		return
	}
	if out.Status == "success" && req.ChannelID > 0 && out.Ticket != "" {
		if err := applyDeviceTicket(c.Request.Context(), owner, out.Ticket, req.ChannelID); err != nil {
			// 票据在数据库提交成功前保持可领取。
			fail(c, 400, err.Error(), "device_apply_failed")
			return
		}
		out.Ticket = ""
		out.ChannelID = req.ChannelID
		auditLog(c, "设备授权绑定成功", deviceVendorLabel(out.Vendor)+" 渠道 "+strconv.FormatInt(req.ChannelID, 10))
	}
	ok(c, out)
}

func AdminDeviceCancel(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		SessionID string `json:"session_id"`
	}
	if c.ShouldBindJSON(&req) != nil || req.SessionID == "" {
		fail(c, 400, "缺少会话标识", "bad_request")
		return
	}
	ok(c, gin.H{"cancelled": services.DeviceBindings.Cancel(owner, req.SessionID)})
}

func AdminDeviceClaim(c *gin.Context) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	var req struct {
		Ticket    string `json:"ticket"`
		ChannelID int64  `json:"channel_id"`
	}
	if c.ShouldBindJSON(&req) != nil || req.ChannelID <= 0 || req.Ticket == "" {
		fail(c, 400, "缺少凭据票据或目标渠道", "bad_request")
		return
	}
	applied, err := applyDeviceTicketDetailed(c.Request.Context(), owner, req.Ticket, req.ChannelID)
	if err != nil {
		fail(c, 400, err.Error(), "device_apply_failed")
		return
	}
	auditLog(c, "设备授权绑定成功", deviceVendorLabel(applied.Vendor)+" 渠道 "+strconv.FormatInt(req.ChannelID, 10))
	ok(c, gin.H{
		"status": "success", "channel_id": req.ChannelID,
		"vendor": applied.Vendor, "method": applied.Method,
		"account": deviceVendorLabel(applied.Vendor),
	})
}

// deviceVendorPair 判断厂商/方式组合是否属于一键绑定，并归一厂商。
func deviceVendorPair(vendor, method string) (string, string, bool) {
	normalized := services.NormalizeDeviceVendor(vendor)
	want, ok := deviceVendorMethods[normalized]
	if !ok || method != want {
		return "", "", false
	}
	return normalized, want, true
}

// applyDeviceTicket 在数据库事务里消费一次性票据（先 db 提交，后消费票据）。
func applyDeviceTicket(ctx context.Context, owner int64, ticket string, id int64) error {
	_, err := applyDeviceTicketDetailed(ctx, owner, ticket, id)
	return err
}

type appliedDeviceTicket struct {
	Vendor string
	Method string
}

func applyDeviceTicketDetailed(ctx context.Context, owner int64, ticket string, id int64) (appliedDeviceTicket, error) {
	var applied appliedDeviceTicket
	err := services.DeviceBindings.WithTicket(owner, ticket, id, func(t services.DeviceTicket) error {
		vendor, method, ok := deviceVendorPair(t.Vendor, t.Method)
		if !ok {
			return errors.New("授权凭据的厂商/方式不正确")
		}
		base, err := services.DeviceChannelBase(t)
		if err != nil {
			return err
		}
		tx, err := db.DB.BeginTx(ctx, nil)
		if err != nil {
			return errors.New("凭据保存失败，请重试")
		}
		defer tx.Rollback()
		var channelVendor, channelMethod string
		if err = tx.QueryRowContext(ctx, "SELECT vendor, method FROM channels WHERE id = ? FOR UPDATE", id).Scan(&channelVendor, &channelMethod); err != nil {
			return errors.New("目标渠道不存在")
		}
		if channelVendor != vendor || channelMethod != method {
			return errors.New("授权凭据不能写入其它厂商或 API Key 渠道")
		}
		_, err = tx.ExecContext(ctx, `UPDATE channels SET base_url = ?, api_key = ?, auth_credential = ?, auth_expires_at = ?, auth_version = auth_version + 1, last_error = '', cooldown_until = NULL WHERE id = ?`,
			base, services.DeviceCredentialMarker(method, id), t.Encrypted, t.ExpiresAt, id)
		if err != nil {
			return errors.New("凭据保存失败，请重试")
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		applied.Vendor = vendor
		applied.Method = method
		return nil
	})
	if err == nil {
		services.MarkChannelsDirty()
	}
	return applied, err
}

// createDeviceChannel 通过一次性票据创建渠道（kiro / workbuddy / cline / grok）。
// 地址由服务端按凭据推导（官方域），管理员无法自定义。
func createDeviceChannel(c *gin.Context, req *channelRequest) {
	owner, found := deviceOwner(c)
	if !found {
		return
	}
	vendor := services.NormalizeDeviceVendor(req.Vendor)
	if vendor == "" {
		vendor = services.DeviceVendorOfMethod(req.Method)
	}
	wantMethod, supported := deviceVendorMethods[vendor]
	if !supported || req.Method != wantMethod || req.Ticket == "" || strings.TrimSpace(req.APIKey) != "" {
		fail(c, 400, "设备授权渠道必须通过一键绑定票据创建，不能填写 API Key 或 OAuth JSON", "invalid_credential")
		return
	}
	if req.ModelPaths != nil && strings.TrimSpace(*req.ModelPaths) != "" {
		fail(c, 400, "设备授权渠道使用固定上游协议，不支持自定义协议路径", "invalid_input")
		return
	}
	userBase := strings.TrimSpace(req.BaseURL)
	if userBase != "" && !deviceBaseLooksOfficial(vendor, userBase) {
		fail(c, 400, "设备授权渠道的接口地址由服务端按账号所在区域（版本）推导，不能自定义", "invalid_url")
		return
	}
	// 先做其余字段的常规校验；base_url 留空传给校验，由票据解密后补上。
	staged := *req
	staged.BaseURL = "https://placeholder.invalid"
	staged.Vendor = vendor
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
	var id int64
	err := services.DeviceBindings.WithTicket(owner, req.Ticket, 0, func(t services.DeviceTicket) error {
		base, err := services.DeviceChannelBase(t)
		if err != nil {
			return err
		}
		if userBase != "" && userBase != base {
			return errors.New("接口地址与授权账号的区域（版本）不一致，请清空后由服务端自动填写")
		}
		tx, err := db.DB.BeginTx(c.Request.Context(), nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		result, err := tx.ExecContext(c.Request.Context(), `INSERT INTO channels (name,vendor,method,base_url,api_key,auth_credential,auth_expires_at,auth_version,models,group_name,headers,model_paths,priority,weight,status) VALUES (?,?,?,?,?,?,?,1,?,?,?,'',?,?,?)`,
			strings.TrimSpace(req.Name), vendor, wantMethod, base, services.DeviceCredentialMarker(wantMethod, 0), t.Encrypted, t.ExpiresAt,
			strings.Join(normalizeModelList(req.Models), ","), optionalGroupName(req.GroupName), normalizeHeaders(req.Headers),
			priority, weight, status)
		if err != nil {
			return err
		}
		id, err = result.LastInsertId()
		if err != nil {
			return err
		}
		// api_key 里的内部标识要带渠道 ID，插入后回填。
		if _, err = tx.ExecContext(c.Request.Context(), "UPDATE channels SET api_key = ? WHERE id = ?", services.DeviceCredentialMarker(wantMethod, id), id); err != nil {
			return err
		}
		return tx.Commit()
	})
	if err != nil {
		fail(c, 400, "创建绑定渠道失败，请重试或重新授权", "device_create_failed")
		return
	}
	services.MarkChannelsDirty()
	auditLog(c, "创建设备授权渠道", deviceVendorLabel(vendor)+" "+wantMethod)
	ch, err := channelByID(id)
	if err == sql.ErrNoRows || err != nil {
		ok(c, gin.H{"id": id, "vendor": vendor, "method": wantMethod, "has_credential": true})
		return
	}
	ok(c, ch)
}

// deviceBaseLooksOfficial 是票据解密前的快速检查：地址必须落在该厂商的官方主机上。
func deviceBaseLooksOfficial(vendor, raw string) bool {
	switch vendor {
	case "kiro":
		return services.IsKiroBaseURL(raw)
	case "workbuddy":
		_, ok := services.WorkBuddyRealmOfBase(raw)
		return ok
	case "cline":
		return strings.TrimRight(raw, "/") == services.ClineAPIBase
	case "grok":
		return services.IsGrokSubscriptionBase(raw)
	}
	return false
}
