package services

// 设备授权绑定（一键绑定）—— Kiro / WorkBuddy / Cline 共用一套会话引擎。
//
// 统一抽象：Start() → {sessionId, userCode, verifyUrl, intervalMs, expiresIn}，
// Poll() → {status: pending|success|denied|expired|error, ticket?}，
// 成功后签发**一次性票据**（5 分钟有效），由渠道创建/更新路径在数据库事务里消费。
//
// 各厂商差异封装在各自文件里（kiro_auth.go / workbuddy_auth.go / cline_auth.go），
// 本文件只负责会话生命周期、轮询节流、单飞与票据。

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type DeviceStart struct {
	SessionID  string `json:"sessionId"`
	Vendor     string `json:"vendor"`
	Method     string `json:"method"`
	UserCode   string `json:"userCode"`
	VerifyURL  string `json:"verifyUrl"`
	IntervalMs int    `json:"intervalMs"`
	ExpiresIn  int    `json:"expiresIn"`
}
type DevicePoll struct {
	Status     string `json:"status"`
	Vendor     string `json:"vendor"`
	Method     string `json:"method"`
	Message    string `json:"message,omitempty"`
	SlowDown   bool   `json:"slowDown,omitempty"`
	IntervalMs int    `json:"intervalMs"`
	Ticket     string `json:"ticket,omitempty"`
	ChannelID  int64  `json:"channel_id,omitempty"`
	// Account 是授权成功后可展示的账号标识（区域 / 平台 / 企业 ID 等）。
	// 只回传非敏感信息，绝不包含 token —— 前端拿它告诉用户「绑到了哪个账号」。
	Account string `json:"account,omitempty"`
	// ExpiresIn 是凭据的有效秒数（0 表示不过期或未提供），供前端提示有效期。
	ExpiresIn int `json:"expires_in,omitempty"`
}

// DeviceStartRequest 是发起绑定的参数（vendor 归一后为 kiro/workbuddy/cline）。
type DeviceStartRequest struct {
	Vendor   string
	Method   string
	Region   string
	StartURL string
	Realm    string
}

type deviceSession struct {
	owner           int64
	vendor          string
	method          string
	channelID       int64
	code            string // Cline 的设备码
	completedTicket string
	expires         time.Time
	interval        time.Duration
	next            time.Time
	polling         bool
	result          *DevicePoll
	kiro            KiroDeviceStart
	workbuddy       WorkBuddyDeviceStart
	grok            GrokDeviceStart
}

// DeviceTicket 是一张一次性凭据兑换票据。
// Encrypted 只在服务端流动，永远不会出现在任何响应里。
type DeviceTicket struct {
	Vendor    string
	Method    string
	Encrypted string
	ExpiresAt int64
	channelID int64
	owner     int64
	expires   time.Time
}

type deviceCredentialEnvelope struct {
	encrypted string
	expiresAt int64
}

type DeviceBindService struct {
	mu       sync.Mutex
	sessions map[string]*deviceSession
	tickets  map[string]*DeviceTicket
	starts   map[int64][]time.Time
}

func NewDeviceBindService() *DeviceBindService {
	return &DeviceBindService{sessions: map[string]*deviceSession{}, tickets: map[string]*DeviceTicket{}, starts: map[int64][]time.Time{}}
}

var DeviceBindings = NewDeviceBindService()

// NormalizeDeviceVendor 把厂商键归一：「cli」是 Cline 的方法键，历史前端也会当厂商键传。
func NormalizeDeviceVendor(vendor string) string {
	switch strings.ToLower(strings.TrimSpace(vendor)) {
	case "cline", "cli":
		return "cline"
	case "kiro":
		return "kiro"
	case "workbuddy":
		return "workbuddy"
	case "grok":
		return "grok"
	default:
		return strings.ToLower(strings.TrimSpace(vendor))
	}
}

// DeviceMethodSupported 判断接入方式是否属于「一键绑定」的设备授权方式。
func DeviceMethodSupported(method string) bool {
	switch strings.TrimSpace(method) {
	case "cli", "kiro", "workbuddy", "grok":
		return true
	}
	return false
}

// DeviceVendorOfMethod 由接入方式反推厂商（前端可能只传 method）。
func DeviceVendorOfMethod(method string) string {
	switch strings.TrimSpace(method) {
	case "cli":
		return "cline"
	case "kiro":
		return "kiro"
	case "workbuddy":
		return "workbuddy"
	case "grok":
		return "grok"
	}
	return ""
}

// SessionVendor 返回会话归属的厂商（poll 时前端可能不带 vendor，据此补全）。
func (s *DeviceBindService) SessionVendor(owner int64, id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.sessions[id]
	if session == nil || session.owner != owner {
		return ""
	}
	return session.vendor
}

// DeviceCredentialMarker 生成设备授权渠道在 api_key 列使用的内部标识。
// 传输层据此识别「该请求要用加密凭据换出真实令牌」，标识本身不是密钥。
func DeviceCredentialMarker(method string, id int64) string {
	switch strings.TrimSpace(method) {
	case "cli":
		return fmt.Sprintf("ooapi-cline-channel-%d", id)
	case "kiro":
		return fmt.Sprintf("ooapi-kiro-channel-%d", id)
	case "workbuddy":
		return fmt.Sprintf("ooapi-workbuddy-channel-%d", id)
	case "grok":
		return fmt.Sprintf("ooapi-grok-channel-%d", id)
	}
	return ""
}

// IsDeviceCredentialMarker 判断一段文本是否为内部凭据标识（用于拒绝把它当 API Key 提交）。
//
// 订阅渠道（codex / claude-oauth / antigravity）用同一格式的内部标识，
// 也必须一起认出来 —— 否则管理员把自己的标识粘进「上游密钥」框会被接受，
// 账号看起来配好了，实际每次请求都 401。
func IsDeviceCredentialMarker(key string) bool {
	for _, prefix := range []string{"ooapi-cline-channel-", "ooapi-kiro-channel-", "ooapi-workbuddy-channel-", "ooapi-grok-channel-"} {
		if strings.HasPrefix(strings.TrimSpace(key), prefix) {
			return true
		}
	}
	return IsLoginCredentialMarker(key)
}

// DeviceUnavailable 返回「该厂商不能一键绑定」的可读原因；可绑定的厂商返回空串。
func DeviceUnavailable(vendor string) string {
	switch NormalizeDeviceVendor(vendor) {
	case "kiro", "workbuddy", "cline", "grok":
		return ""
	case "qoder":
		return "Qoder 不支持服务端设备授权；官方流程依赖浏览器会话和本机客户端，请使用 PAT 与已配置的兼容桥"
	default:
		return "该厂商或接入方式不支持一键绑定"
	}
}

// ValidateDeviceVendor 校验厂商与接入方式的组合。
func ValidateDeviceVendor(vendor, method string) error {
	m := strings.TrimSpace(method)
	switch NormalizeDeviceVendor(vendor) {
	case "kiro":
		if m == "" || m == "kiro" {
			return nil
		}
		return errors.New("Kiro 一键绑定对应 kiro 接入方式；api 方式必须填写正式 API Key")
	case "workbuddy":
		if m == "" || m == "workbuddy" {
			return nil
		}
		return errors.New("WorkBuddy 一键绑定对应 workbuddy 接入方式；api 方式必须填写正式 API Key")
	case "cline":
		if m == "" || m == "cli" {
			return nil
		}
		return errors.New("Cline 一键绑定仅用于 cli 账号接入；api 方式必须填写正式 API Key")
	case "grok":
		if m == "" || m == "grok" {
			return nil
		}
		return errors.New("Grok 一键登录对应 grok 接入方式；api 方式必须填写正式 API Key")
	default:
		return errors.New(DeviceUnavailable(vendor))
	}
}

func deviceID() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// deviceHTTPJSON 是设备授权链路统一的 JSON 调用：带超时、错误归一、响应体上限。
// body 为 nil 时发 GET；headers 在默认头之后覆盖（厂商私有头）。
func deviceHTTPJSON(ctx context.Context, client *http.Client, method, target string, body any, headers map[string]string) (int, map[string]any, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return 0, nil, errors.New("无法构造授权请求")
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "OOAPI-Gateway/1.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, errors.New("授权服务连接失败或超时")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		return resp.StatusCode, nil, errors.New("授权响应过大或读取失败")
	}
	var out map[string]any
	if len(data) > 0 && json.Unmarshal(data, &out) != nil {
		out = nil
	}
	return resp.StatusCode, out, nil
}

// mapObject 取嵌套对象（响应可能把字段放在 data 里，也可能平铺）。
func mapObject(j map[string]any, key string) map[string]any {
	if j == nil {
		return nil
	}
	if obj, ok := j[key].(map[string]any); ok {
		return obj
	}
	return nil
}

func (s *DeviceBindService) sweep(now time.Time) {
	for id, session := range s.sessions {
		if !now.Before(session.expires) && !session.polling {
			delete(s.sessions, id)
		}
	}
	for id, ticket := range s.tickets {
		if !now.Before(ticket.expires) {
			delete(s.tickets, id)
		}
	}
	for owner, times := range s.starts {
		fresh := times[:0]
		for _, at := range times {
			if now.Sub(at) < time.Minute {
				fresh = append(fresh, at)
			}
		}
		if len(fresh) == 0 {
			delete(s.starts, owner)
		} else {
			s.starts[owner] = fresh
		}
	}
}

// Start 发起一次设备授权。厂商流程在各自 auth 文件中实现。
func (s *DeviceBindService) Start(ctx context.Context, owner, channelID int64, req DeviceStartRequest) (DeviceStart, error) {
	if owner <= 0 {
		return DeviceStart{}, errors.New("未登录")
	}
	vendor := NormalizeDeviceVendor(req.Vendor)
	if err := ValidateDeviceVendor(vendor, req.Method); err != nil {
		return DeviceStart{}, err
	}
	now := time.Now()
	s.mu.Lock()
	s.sweep(now)
	if len(s.starts[owner]) >= 10 || len(s.sessions)+len(s.tickets) >= 2000 {
		s.mu.Unlock()
		return DeviceStart{}, errors.New("授权请求过于频繁，请稍后再试")
	}
	s.starts[owner] = append(s.starts[owner], now)
	s.mu.Unlock()

	var session *deviceSession
	var out DeviceStart
	switch vendor {
	case "kiro":
		start, err := KiroStartDevice(ctx, req.StartURL, req.Region)
		if err != nil {
			return DeviceStart{}, err
		}
		session = &deviceSession{
			owner: owner, vendor: "kiro", method: "kiro", channelID: channelID, kiro: start,
			expires:  time.Now().Add(time.Duration(start.ExpiresIn) * time.Second),
			interval: time.Duration(start.Interval) * time.Second,
		}
		out = DeviceStart{Vendor: "kiro", Method: "kiro", UserCode: start.UserCode, VerifyURL: start.VerifyURL, IntervalMs: start.Interval * 1000, ExpiresIn: start.ExpiresIn}
	case "workbuddy":
		start, err := WorkBuddyStartDevice(ctx, req.Realm)
		if err != nil {
			return DeviceStart{}, err
		}
		session = &deviceSession{
			owner: owner, vendor: "workbuddy", method: "workbuddy", channelID: channelID, workbuddy: start,
			expires:  time.Now().Add(time.Duration(start.ExpiresIn) * time.Second),
			interval: time.Duration(start.Interval) * time.Second,
		}
		out = DeviceStart{Vendor: "workbuddy", Method: "workbuddy", VerifyURL: start.VerifyURL, IntervalMs: start.Interval * 1000, ExpiresIn: start.ExpiresIn}
	case "grok":
		start, err := GrokStartDevice(ctx)
		if err != nil {
			return DeviceStart{}, err
		}
		session = &deviceSession{
			owner: owner, vendor: "grok", method: "grok", channelID: channelID, grok: start,
			expires:  time.Now().Add(time.Duration(start.ExpiresIn) * time.Second),
			interval: time.Duration(start.Interval) * time.Second,
		}
		out = DeviceStart{Vendor: "grok", Method: "grok", UserCode: start.UserCode, VerifyURL: start.VerifyURL, IntervalMs: start.Interval * 1000, ExpiresIn: start.ExpiresIn}
	default: // cline
		status, j, err := clineJSON(ctx, clineDeviceURL, map[string]string{"client_id": clineClientID})
		if err != nil {
			return DeviceStart{}, err
		}
		code := clineString(j, "device_code")
		verify := clineString(j, "verification_uri_complete", "verification_uri")
		u, urlErr := url.Parse(verify)
		if status < 200 || status >= 300 || code == "" || urlErr != nil || u.Scheme != "https" || u.Host != "authkit.cline.bot" || u.User != nil {
			return DeviceStart{}, fmt.Errorf("Cline 发起授权失败或授权地址不合法（HTTP %d）", status)
		}
		ttl := clineSeconds(j, 300, "expires_in")
		if ttl > 900 {
			ttl = 900
		}
		interval := clineSeconds(j, 5, "interval")
		if interval < 3 {
			interval = 3
		}
		session = &deviceSession{
			owner: owner, vendor: "cline", method: "cli", channelID: channelID, code: code,
			expires:  time.Now().Add(time.Duration(ttl) * time.Second),
			interval: time.Duration(interval) * time.Second,
		}
		out = DeviceStart{Vendor: "cline", Method: "cli", UserCode: clineString(j, "user_code"), VerifyURL: verify, IntervalMs: interval * 1000, ExpiresIn: ttl}
	}
	id, err := deviceID()
	if err != nil {
		return DeviceStart{}, err
	}
	s.mu.Lock()
	s.sessions[id] = session
	s.mu.Unlock()
	out.SessionID = id
	return out, nil
}

// pollVendor 对上游做一次轮询并把成功凭据加密。
func (s *DeviceBindService) pollVendor(ctx context.Context, vendor, clineCode string, kiroSess KiroDeviceStart, wbSess WorkBuddyDeviceStart, grokSess GrokDeviceStart) (DevicePoll, deviceCredentialEnvelope, error) {
	switch vendor {
	case "kiro":
		out, cred, err := KiroPollDevice(ctx, kiroSess)
		if err != nil {
			return DevicePoll{}, deviceCredentialEnvelope{}, err
		}
		if out.Status != "success" {
			return out, deviceCredentialEnvelope{}, nil
		}
		encrypted, err := EncryptKiroCredential(cred)
		if err != nil {
			return DevicePoll{Status: "error", Vendor: "kiro", Method: "kiro", Message: "Kiro 授权凭据保存失败，请重新绑定"}, deviceCredentialEnvelope{}, nil
		}
		// Kiro 凭据里能展示的就是区域（Builder ID 模式下没有可读账号名）。
		out.Account = "AWS 区域 " + cred.Region
		out.ExpiresIn = secondsUntil(cred.ExpiresAt)
		return out, deviceCredentialEnvelope{encrypted: encrypted, expiresAt: cred.ExpiresAt}, nil
	case "workbuddy":
		out, cred, err := WorkBuddyPollDevice(ctx, wbSess)
		if err != nil {
			return DevicePoll{}, deviceCredentialEnvelope{}, err
		}
		if out.Status != "success" {
			return out, deviceCredentialEnvelope{}, nil
		}
		encrypted, err := EncryptWorkBuddyCredential(cred)
		if err != nil {
			return DevicePoll{Status: "error", Vendor: "workbuddy", Method: "workbuddy", Message: "WorkBuddy 授权凭据保存失败，请重新绑定"}, deviceCredentialEnvelope{}, nil
		}
		out.Account = workBuddyAccountLabel(cred)
		out.ExpiresIn = secondsUntil(cred.ExpiresAt)
		return out, deviceCredentialEnvelope{encrypted: encrypted, expiresAt: cred.ExpiresAt}, nil
	case "grok":
		out, cred, err := GrokPollDevice(ctx, grokSess)
		if err != nil {
			return DevicePoll{}, deviceCredentialEnvelope{}, err
		}
		if out.Status != "success" {
			return out, deviceCredentialEnvelope{}, nil
		}
		encrypted, err := EncryptGrokCredential(cred)
		if err != nil {
			return DevicePoll{Status: "error", Vendor: "grok", Method: "grok", Message: "Grok 授权凭据保存失败，请重新登录"}, deviceCredentialEnvelope{}, nil
		}
		out.Account = grokAccountLabel(cred)
		out.ExpiresIn = secondsUntil(cred.ExpiresAt)
		return out, deviceCredentialEnvelope{encrypted: encrypted, expiresAt: cred.ExpiresAt}, nil
	default:
		status, j, err := clineJSON(ctx, clineAuthenticateURL, map[string]string{"client_id": clineClientID, "device_code": clineCode, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
		if err != nil {
			return DevicePoll{}, deviceCredentialEnvelope{}, err
		}
		out, cred := judgeClineDevice(status, j)
		if out.Status != "success" {
			return out, deviceCredentialEnvelope{}, nil
		}
		// 与原导入路径一致：先拿 WorkOS 凭据去 Cline 官方续期接口校验一次。
		if cred.RefreshToken != "" {
			cred, err = refreshClineCredential(ctx, cred)
			if err != nil {
				return DevicePoll{Status: "error", Vendor: "cline", Method: "cli", Message: "授权凭据未能通过 Cline 官方续期接口校验，请重新绑定或稍后重试"}, deviceCredentialEnvelope{}, nil
			}
		}
		encrypted, err := EncryptClineCredential(cred)
		if err != nil {
			return DevicePoll{Status: "error", Vendor: "cline", Method: "cli", Message: "Cline 授权凭据保存失败，请重新绑定"}, deviceCredentialEnvelope{}, nil
		}
		out.Account = "Cline 账号"
		out.ExpiresIn = secondsUntil(cred.ExpiresAt)
		return out, deviceCredentialEnvelope{encrypted: encrypted, expiresAt: cred.ExpiresAt}, nil
	}
}

// secondsUntil 把绝对过期时间换算成剩余秒数；已过期或未设置返回 0。
func secondsUntil(expiresAt int64) int {
	if expiresAt <= 0 {
		return 0
	}
	left := expiresAt - time.Now().Unix()
	if left <= 0 {
		return 0
	}
	if left > 1<<31-1 {
		return 1<<31 - 1
	}
	return int(left)
}

// workBuddyAccountLabel 拼出可展示的账号标识：优先企业/用户 ID，其次区域。
// 这些是 ID 而不是 token，回传给前端只用于「绑到了哪个账号」的确认。
func workBuddyAccountLabel(cred WorkBuddyCredential) string {
	parts := []string{}
	if cred.Realm == "cn" {
		parts = append(parts, "中国版")
	} else if cred.Realm != "" {
		parts = append(parts, "国际版")
	}
	if cred.EnterpriseID != "" {
		parts = append(parts, "企业 "+cred.EnterpriseID)
	} else if cred.UserID != "" {
		parts = append(parts, "用户 "+cred.UserID)
	}
	if len(parts) == 0 {
		return ""
	}
	return strings.Join(parts, " · ")
}

func judgeClineDevice(status int, j map[string]any) (DevicePoll, ClineCredential) {
	out := DevicePoll{Vendor: "cline", Method: "cli"}
	if status >= 200 && status < 300 {
		cred := clineCredentialFrom(j, "")
		if cred.AccessToken != "" || cred.RefreshToken != "" {
			out.Status = "success"
			return out, cred
		}
	}
	switch clineString(j, "error") {
	case "authorization_pending":
		out.Status = "pending"
		out.Message = "等待在浏览器中完成授权"
	case "slow_down":
		out.Status = "pending"
		out.SlowDown = true
		out.Message = "轮询过快，已自动放慢"
	case "access_denied":
		out.Status = "denied"
		out.Message = "已拒绝本次授权"
	case "expired_token":
		out.Status = "expired"
		out.Message = "授权已过期，请重新绑定"
	default:
		if status == 410 {
			out.Status = "expired"
		} else {
			out.Status = "error"
		}
		out.Message = fmt.Sprintf("Cline 授权返回未识别响应（HTTP %d），请重新绑定或稍后重试", status)
	}
	return out, ClineCredential{}
}

// Poll 轮询一次。会话级 in-flight 互斥：并发轮询会跳过上游，避免重复兑换。
func (s *DeviceBindService) Poll(ctx context.Context, owner int64, id string, channelID int64) (DevicePoll, error) {
	now := time.Now()
	s.mu.Lock()
	session := s.sessions[id]
	if session == nil || session.owner != owner {
		s.mu.Unlock()
		return DevicePoll{Status: "expired", Message: "绑定会话已失效，请重新发起"}, nil
	}
	if session.channelID != channelID {
		s.mu.Unlock()
		return DevicePoll{}, errors.New("目标渠道与发起授权时不一致，请重新绑定")
	}
	if !now.Before(session.expires) {
		delete(s.sessions, id)
		s.mu.Unlock()
		return DevicePoll{Status: "expired", Message: "授权已过期"}, nil
	}
	if session.result != nil {
		result := *session.result
		s.mu.Unlock()
		return result, nil
	}
	pending := DevicePoll{Status: "pending", Vendor: session.vendor, Method: session.method, IntervalMs: int(session.interval.Milliseconds())}
	if session.polling || now.Before(session.next) {
		s.mu.Unlock()
		return pending, nil
	}
	session.polling = true
	session.next = now.Add(session.interval)
	vendor := session.vendor
	clineCode := session.code
	kiroSess := session.kiro
	wbSess := session.workbuddy
	grokSess := session.grok
	s.mu.Unlock()

	out, credential, err := s.pollVendor(ctx, vendor, clineCode, kiroSess, wbSess, grokSess)

	s.mu.Lock()
	defer s.mu.Unlock()
	session.polling = false
	if s.sessions[id] != session || !time.Now().Before(session.expires) {
		return DevicePoll{Status: "expired"}, nil
	}
	if err != nil {
		return DevicePoll{}, err
	}
	if out.SlowDown {
		session.interval += 5 * time.Second
		session.next = time.Now().Add(session.interval)
	}
	out.IntervalMs = int(session.interval.Milliseconds())
	if out.Status == "success" {
		ticket, terr := deviceID()
		if terr != nil {
			return DevicePoll{}, terr
		}
		s.tickets[ticket] = &DeviceTicket{
			Vendor: session.vendor, Method: session.method, Encrypted: credential.encrypted, ExpiresAt: credential.expiresAt,
			channelID: channelID, owner: owner, expires: time.Now().Add(5 * time.Minute),
		}
		out.Ticket = ticket
		session.expires = time.Now().Add(5 * time.Minute)
	}
	if out.Status != "pending" {
		session.code = ""
		session.kiro.DeviceCode = ""
		session.workbuddy.State = ""
		session.grok.DeviceCode = ""
		session.result = &out
	}
	return out, nil
}

func (s *DeviceBindService) Cancel(owner int64, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.sessions[id]
	if session == nil || session.owner != owner {
		return false
	}
	if session.result != nil {
		delete(s.tickets, session.result.Ticket)
	}
	delete(s.sessions, id)
	return true
}

// DeviceChannelBase 由票据内的加密凭据推导渠道应使用的官方接口地址。
// 管理员永远无法直接把 base_url 指向非官方主机。
func DeviceChannelBase(t DeviceTicket) (string, error) {
	switch NormalizeDeviceVendor(t.Vendor) {
	case "cline":
		return ClineAPIBase, nil
	case "kiro":
		cred, err := DecryptKiroCredential(t.Encrypted)
		if err != nil {
			return "", err
		}
		return KiroAPIBaseURL(cred.Region), nil
	case "workbuddy":
		cred, err := DecryptWorkBuddyCredential(t.Encrypted)
		if err != nil {
			return "", err
		}
		return WorkBuddyChannelBaseURL(cred.Realm), nil
	case "grok":
		// Grok 订阅渠道固定走官方 CLI 代理地址（服务端推导，不采用任何用户输入）。
		if _, err := DecryptGrokCredential(t.Encrypted); err != nil {
			return "", err
		}
		return GrokChannelBaseURL(), nil
	}
	return "", errors.New("未知的设备授权厂商")
}

// PreviewTicket 读取票据副本（不消费、不占用）。
//
// 用途：一键授权成功后、账号还没落库时就要把模型清单拉回来填进表单。
// 拉模型是只读操作，不应该消耗票据 —— 票据仍留给随后的「创建账号」使用。
// 返回副本而不是指针：调用方会在锁外做网络请求，共享内部状态不安全。
func (s *DeviceBindService) PreviewTicket(owner int64, id string) (DeviceTicket, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(time.Now())
	ticket := s.tickets[id]
	if ticket == nil || ticket.owner != owner {
		return DeviceTicket{}, false
	}
	return *ticket, true
}

// WithTicket 在持有票据锁的前提下执行 apply；apply 成功才消费票据。
// 把数据库事务放进 apply 里，并发领取就不可能两边都成功。
func (s *DeviceBindService) WithTicket(owner int64, id string, channelID int64, apply func(DeviceTicket) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sweep(time.Now())
	ticket := s.tickets[id]
	if ticket == nil || ticket.owner != owner {
		// 幂等确认：已提交的重绑重试直接成功。
		if channelID > 0 {
			for _, session := range s.sessions {
				if session.owner == owner && session.completedTicket == id && session.result != nil && session.result.ChannelID == channelID {
					return nil
				}
			}
		}
		return errors.New("凭据已过期或不存在，请重新绑定")
	}
	if ticket.channelID != 0 && ticket.channelID != channelID {
		return errors.New("授权票据不属于该目标渠道")
	}
	if err := apply(*ticket); err != nil {
		return err
	}
	delete(s.tickets, id)
	for _, session := range s.sessions {
		if session.result != nil && session.result.Ticket == id {
			session.completedTicket = id
			session.result.Ticket = ""
			session.result.ChannelID = channelID
		}
	}
	return nil
}
