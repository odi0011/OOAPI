package handlers

/*
媒体库接口。

权限口径：普通用户只能操作自己的；管理员可管理全部。
读取走「签名 URL」：聊天消息里的 <img> 带不了 Authorization 头，
所以 /:id/raw 允许用 query 签名访问（签名由服务端现签、不落库）。

路由顺序（见 router.go）：/media/avatar、/media/stats 必须注册在
/media/:id 之前，否则会被 :id 通配吞掉（id 变成字符串 "avatar"）。
*/
import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// isMediaAdmin 判断当前是否管理员（删除强制、列表筛选等特权动作）。
func isMediaAdmin(c *gin.Context) bool {
	role, ok := currentRole(c)
	return ok && role.AtLeast(authz.RoleAdmin)
}

// mediaFail 把服务层业务错误映射成 HTTP 状态与错误码。
// 业务错误码原样下发（前端据此提示），而不是笼统 500。
func mediaFail(c *gin.Context, err error) {
	code := services.MediaErrorCode(err)
	if code == "" {
		log.Printf("[media] 保存失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存文件失败，请稍后重试", "server_error")
		return
	}
	status := http.StatusBadRequest
	switch code {
	case services.MediaCodeDisabled:
		status = http.StatusForbidden
	case services.MediaCodeTooLarge, services.MediaCodeQuota:
		status = http.StatusRequestEntityTooLarge
	case services.MediaCodeType:
		status = http.StatusUnsupportedMediaType
	}
	fail(c, status, services.MediaErrorMessage(err), code)
}

// ---------------------------------------------------------------------------
// 上传限速
// ---------------------------------------------------------------------------

// 内存固定窗口限速：每用户每分钟 60 次上传。
// 只为挡住脚本化滥用（大文件写盘是重操作），不需要分布式精度：
// 单进程计数器足够，且失败开放（限速器本身不阻断正常用户）。
const (
	mediaUploadWindowSec = 60
	mediaUploadMaxPerWin = 60
)

type mediaUploadBucket struct {
	windowStart time.Time
	count       int
}

var mediaUploadLimiter = struct {
	mu      sync.Mutex
	buckets map[int64]*mediaUploadBucket
}{buckets: map[int64]*mediaUploadBucket{}}

func mediaUploadAllowed(userID int64) bool {
	l := &mediaUploadLimiter
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b, ok := l.buckets[userID]
	if !ok || now.Sub(b.windowStart) >= mediaUploadWindowSec*time.Second || now.Before(b.windowStart) {
		l.buckets[userID] = &mediaUploadBucket{windowStart: now, count: 1}
		if len(l.buckets) > 10000 {
			for k, v := range l.buckets {
				if now.Sub(v.windowStart) >= mediaUploadWindowSec*time.Second {
					delete(l.buckets, k)
				}
			}
		}
		return true
	}
	b.count++
	return b.count <= mediaUploadMaxPerWin
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

// MediaUpload 上传一个文件（multipart：file + source）。
// 前端用 FormData 发送；类型与尺寸一律服务端嗅探，不信任前端声明。
func MediaUpload(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	if !services.MediaEnabled() {
		fail(c, http.StatusForbidden, "媒体库功能已关闭", services.MediaCodeDisabled)
		return
	}
	if !mediaUploadAllowed(user.ID) {
		fail(c, http.StatusTooManyRequests, "上传过于频繁，请稍后再试", "rate_limited")
		return
	}

	header, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, "请选择要上传的文件", "no_file")
		return
	}
	maxBytes := services.MaxFileBytes()
	if header.Size > maxBytes {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("文件过大：上限 %dMB", maxBytes>>20), services.MediaCodeTooLarge)
		return
	}
	buf, err := readUploadLimited(header, maxBytes)
	if err != nil {
		if errors.Is(err, errUploadTooLarge) {
			fail(c, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("文件过大：上限 %dMB", maxBytes>>20), services.MediaCodeTooLarge)
			return
		}
		log.Printf("[media] 读取上传文件失败: %v", err)
		fail(c, http.StatusBadRequest, "读取上传文件失败", "read_failed")
		return
	}
	if len(buf) == 0 {
		fail(c, http.StatusBadRequest, "文件内容为空", services.MediaCodeEmpty)
		return
	}

	source := services.NormalizeMediaSource(c.PostForm("source"))
	saved, err := services.SaveBuffer(services.SaveMediaInput{
		Buffer:   buf,
		UserID:   user.ID,
		OrigName: header.Filename,
		Source:   source,
	})
	if err != nil {
		mediaFail(c, err)
		return
	}

	usedBytes := int64(0)
	if st, serr := services.UserStats(user.ID); serr != nil {
		log.Printf("[media] 统计已用空间失败: %v", serr)
	} else {
		usedBytes = st.Bytes
	}

	ok(c, gin.H{
		"id":        saved.ID,
		"sha256":    saved.Sha256,
		"size":      saved.Size,
		"mime":      saved.Mime,
		"kind":      saved.Kind,
		"ext":       saved.Ext,
		"width":     saved.Width,
		"height":    saved.Height,
		"orig_name": truncateRunes(strings.TrimSpace(header.Filename), 255),
		"source":    source,
		"deduped":   saved.Deduped,
		"url":       services.MediaURL(saved.ID),
		"quota": gin.H{
			"used_bytes":  usedBytes,
			"quota_bytes": services.QuotaBytes(),
		},
	})
}

var errUploadTooLarge = errors.New("upload too large")

// readUploadLimited 读取上传内容，超过 limit 立刻判错（不把超大文件读进内存）。
func readUploadLimited(header *multipart.FileHeader, limit int64) ([]byte, error) {
	src, err := header.Open()
	if err != nil {
		return nil, err
	}
	defer src.Close()
	buf, err := io.ReadAll(io.LimitReader(src, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > limit {
		return nil, errUploadTooLarge
	}
	return buf, nil
}

// truncateRunes 按字符数截断，避免把多字节字符切成半个（MySQL utf8mb4 列宽按字符算）。
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	i, n := 0, 0
	for i = range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

// ---------------------------------------------------------------------------
// 列表 / 统计 / 详情
// ---------------------------------------------------------------------------

// MediaList 媒体库列表。普通用户强制只看自己；管理员可指定 user_id 与 status。
func MediaList(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	admin := isMediaAdmin(c)

	page := mediaIntQuery(c.Query("p"), 1, 1, 1<<30)
	pageSize := mediaIntQuery(c.Query("page_size"), 24, 1, 100)

	where := []string{}
	args := []any{}
	if !admin {
		where = append(where, "user_id = ?")
		args = append(args, user.ID)
	} else if v := strings.TrimSpace(c.Query("user_id")); v != "" {
		if uid := mediaIntQuery(v, 0, 1, 1<<30); uid > 0 {
			where = append(where, "user_id = ?")
			args = append(args, uid)
		}
	}
	if kind := strings.TrimSpace(c.Query("kind")); kind == services.MediaKindImage || kind == services.MediaKindFile {
		where = append(where, "kind = ?")
		args = append(args, kind)
	}
	if q := strings.TrimSpace(c.Query("q")); q != "" {
		where = append(where, "orig_name LIKE ? ESCAPE '\\\\'")
		args = append(args, "%"+escapeLike(truncateRunes(q, 64))+"%")
	}
	// 默认只看正常文件；管理员可显式查已删文件（status=2）。
	status := services.MediaStatusNormal
	if admin {
		if v := strings.TrimSpace(c.Query("status")); v != "" {
			if n := mediaIntQuery(v, 1, 1, 2); n > 0 {
				status = n
			}
		}
	}
	where = append(where, "status = ?")
	args = append(args, status)

	clause := " WHERE " + strings.Join(where, " AND ")

	var total int64
	if err := db.DB.QueryRow("SELECT COUNT(*) FROM media"+clause, args...).Scan(&total); err != nil {
		log.Printf("[media] 统计列表总数失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}

	offset := (page - 1) * pageSize
	rows, err := queryRows(
		`SELECT id, user_id, size, mime, kind, ext, orig_name, source, width, height, ref_count, status, created_at
		   FROM media`+clause+` ORDER BY id DESC LIMIT ? OFFSET ?`,
		append(args, pageSize, offset)...,
	)
	if err != nil {
		log.Printf("[media] 查询列表失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var r services.MediaRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.Size, &r.Mime, &r.Kind, &r.Ext, &r.OrigName,
			&r.Source, &r.Width, &r.Height, &r.RefCount, &r.Status, &r.CreatedAt); err != nil {
			log.Printf("[media] 扫描列表失败: %v", err)
			fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
			return
		}
		items = append(items, mediaListItem(r))
	}
	if err := rows.Err(); err != nil {
		log.Printf("[media] 遍历列表失败: %v", err)
	}

	ok(c, gin.H{
		"items":     items,
		"total":     total,
		"page":      page,
		"page_size": pageSize,
	})
}

func mediaListItem(r services.MediaRow) gin.H {
	return gin.H{
		"id":         r.ID,
		"user_id":    r.UserID,
		"size":       r.Size,
		"mime":       r.Mime,
		"kind":       r.Kind,
		"ext":        r.Ext,
		"orig_name":  r.OrigName,
		"source":     r.Source,
		"width":      r.Width,
		"height":     r.Height,
		"ref_count":  r.RefCount,
		"status":     r.Status,
		"created_at": r.CreatedAt,
		"url":        services.MediaURL(r.ID),
	}
}

func mediaDetailView(r services.MediaRow) gin.H {
	return gin.H{
		"id":             r.ID,
		"user_id":        r.UserID,
		"sha256":         r.Sha256,
		"size":           r.Size,
		"mime":           r.Mime,
		"kind":           r.Kind,
		"ext":            r.Ext,
		"orig_name":      r.OrigName,
		"source":         r.Source,
		"width":          r.Width,
		"height":         r.Height,
		"ref_count":      r.RefCount,
		"status":         r.Status,
		"created_at":     r.CreatedAt,
		"last_access_at": r.LastAccessAt,
		"url":            services.MediaURL(r.ID),
	}
}

// MediaStats 媒体库统计。普通用户看自己；管理员可看指定用户或全站。
func MediaStats(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	scope := "self"
	uid := user.ID
	if isMediaAdmin(c) {
		if v := strings.TrimSpace(c.Query("user_id")); v != "" {
			scope = "user"
			uid = int64(mediaIntQuery(v, 0, 0, 1<<30))
		} else {
			scope = "all"
		}
	}

	var st *services.MediaStats
	var err error
	if scope == "all" {
		st, err = services.AllStats()
	} else {
		st, err = services.UserStats(uid)
	}
	if err != nil {
		log.Printf("[media] 统计失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}

	quotaBytes := int64(0)
	if scope != "all" {
		quotaBytes = services.QuotaBytes()
	}
	ok(c, gin.H{
		"scope":          scope,
		"count":          st.Count,
		"bytes":          st.Bytes,
		"quota_bytes":    quotaBytes,
		"max_file_bytes": services.MaxFileBytes(),
		"enabled":        services.MediaEnabled(),
		"orphan_hours":   services.OrphanHours(),
		"retention_days": services.RetentionDays(),
		"by_kind":        st.ByKind,
	})
}

// MediaDetail 文件详情（本人或管理员）。
func MediaDetail(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	row, err := services.GetMedia(mediaIDParam(c))
	if errors.Is(err, sql.ErrNoRows) || row == nil {
		fail(c, http.StatusNotFound, "文件不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[media] 查询详情失败: %v", err)
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}
	if row.UserID != user.ID && !isMediaAdmin(c) {
		fail(c, http.StatusForbidden, "无权访问", "forbidden")
		return
	}
	ok(c, mediaDetailView(*row))
}

// ---------------------------------------------------------------------------
// 改名 / 删除
// ---------------------------------------------------------------------------

// MediaRename 修改展示用文件名（磁盘路径由 sha 决定，不受影响）。
func MediaRename(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	row, err := services.GetMedia(mediaIDParam(c))
	if errors.Is(err, sql.ErrNoRows) || row == nil {
		fail(c, http.StatusNotFound, "文件不存在", "not_found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}
	if row.UserID != user.ID && !isMediaAdmin(c) {
		fail(c, http.StatusForbidden, "无权操作", "forbidden")
		return
	}

	var req struct {
		OrigName string `json:"orig_name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		fail(c, http.StatusBadRequest, "请求格式不正确", "bad_request")
		return
	}
	name := strings.TrimSpace(req.OrigName)
	if len([]rune(name)) > 255 {
		fail(c, http.StatusBadRequest, "文件名最长 255 个字符", "invalid_orig_name")
		return
	}
	if _, err := exec("UPDATE media SET orig_name = ? WHERE id = ?", name, row.ID); err != nil {
		log.Printf("[media] 改名失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存失败，请稍后重试", "server_error")
		return
	}
	row.OrigName = name
	ok(c, mediaDetailView(*row))
}

// MediaDelete 软删文件。仍被引用时拒绝（除非管理员 force=1，会一并解绑活引用）。
func MediaDelete(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	row, err := services.GetMedia(mediaIDParam(c))
	if errors.Is(err, sql.ErrNoRows) || row == nil {
		fail(c, http.StatusNotFound, "文件不存在", "not_found")
		return
	}
	if err != nil {
		fail(c, http.StatusInternalServerError, "查询失败，请稍后重试", "server_error")
		return
	}
	admin := isMediaAdmin(c)
	if row.UserID != user.ID && !admin {
		fail(c, http.StatusForbidden, "无权操作", "forbidden")
		return
	}

	force := admin && strings.TrimSpace(c.Query("force")) == "1"
	if row.RefCount > 0 && !force {
		// 仍被引用时直接删会让会话/帖子里的图变成死链，所以拒绝并列出引用来源。
		refs, rerr := services.LiveRefs(row.ID, 10)
		if rerr != nil {
			refs = []services.MediaRef{}
		}
		c.JSON(http.StatusConflict, gin.H{
			"success": false,
			"error": gin.H{
				"message": fmt.Sprintf("该文件仍被 %d 处引用，请先删除对应内容（或由管理员强制删除）", row.RefCount),
				"code":    "media_in_use",
			},
			"data": gin.H{"refs": refs},
		})
		return
	}
	if force {
		// 强制删除：把活引用一并解绑，避免那些内容留下死链；
		// 引用记录软删保留，便于事后追溯「这个文件曾被谁引用过」。
		if _, err := services.ReleaseMediaRefs(row.ID); err != nil {
			log.Printf("[media] 解绑引用失败: %v", err)
		}
	}
	if _, err := exec(
		"UPDATE media SET status = ?, deleted_at = NOW() WHERE id = ?",
		services.MediaStatusDeleted, row.ID,
	); err != nil {
		log.Printf("[media] 删除失败: %v", err)
		fail(c, http.StatusInternalServerError, "删除失败，请稍后重试", "server_error")
		return
	}
	ok(c, gin.H{
		"id":      row.ID,
		"status":  services.MediaStatusDeleted,
		"message": "已删除（保留期后可回收）",
	})
}

// ---------------------------------------------------------------------------
// 原始文件流
// ---------------------------------------------------------------------------

// MediaRaw 下发文件内容。三种放行方式：签名有效 / 本人 / 管理员。
func MediaRaw(c *gin.Context) {
	id := mediaIDParam(c)
	row, err := services.GetMedia(id)
	if errors.Is(err, sql.ErrNoRows) || row == nil {
		fail(c, http.StatusNotFound, "文件不存在", "not_found")
		return
	}
	if err != nil {
		log.Printf("[media] 读取文件失败: %v", err)
		fail(c, http.StatusInternalServerError, "读取失败，请稍后重试", "server_error")
		return
	}

	signed := services.VerifyMediaSign(id, c.Query("s"))
	authed := false
	if user, logged := currentUser(c); logged {
		authed = row.UserID == user.ID || isMediaAdmin(c)
	}
	if !signed && !authed {
		fail(c, http.StatusForbidden, "无权访问", "forbidden")
		return
	}
	if row.Status == services.MediaStatusDeleted {
		fail(c, http.StatusGone, "文件已删除", "gone")
		return
	}

	buf, err := services.ReadBlob(row)
	if err != nil {
		fail(c, http.StatusNotFound, "文件内容缺失（可能已被清理）", "blob_missing")
		return
	}

	// 最近访问时间只用于识别冷数据，失败不影响下载。
	go func() { _ = services.TouchLastAccess(id) }()

	mime := row.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	c.Header("Cache-Control", "private, max-age=31536000, immutable")
	c.Header("X-Content-Type-Options", "nosniff")
	// 只有图片允许内联渲染；其余一律附件下载（防 HTML/脚本被当页面执行）。
	inline := mime == "image/png" || mime == "image/jpeg" || mime == "image/gif" || mime == "image/webp"
	if !inline || c.Query("download") == "1" {
		name := row.OrigName
		if name == "" {
			ext := row.Ext
			if ext == "" {
				ext = "bin"
			}
			sha := row.Sha256
			if len(sha) > 8 {
				sha = sha[:8]
			}
			name = sha + "." + ext
		}
		c.Header("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	}
	c.Data(http.StatusOK, mime, buf)
}

// ---------------------------------------------------------------------------
// 头像
// ---------------------------------------------------------------------------

// MediaAvatar 公开头像流（无头像 → 404，前端回退首字母色块）。
func MediaAvatar(c *gin.Context) {
	uid := mediaIntQuery(c.Param("userId"), 0, 0, 1<<30)
	if uid <= 0 {
		fail(c, http.StatusNotFound, "无头像", "no_avatar")
		return
	}
	var mediaID int64
	if err := db.DB.QueryRow("SELECT avatar_media_id FROM users WHERE id = ?", uid).Scan(&mediaID); err != nil || mediaID <= 0 {
		fail(c, http.StatusNotFound, "无头像", "no_avatar")
		return
	}
	row, err := services.GetMedia(mediaID)
	if err != nil || row.Status != services.MediaStatusNormal {
		fail(c, http.StatusNotFound, "无头像", "no_avatar")
		return
	}
	buf, err := services.ReadBlob(row)
	if err != nil {
		fail(c, http.StatusNotFound, "无头像", "no_avatar")
		return
	}
	mime := row.Mime
	if mime == "" {
		mime = "image/jpeg"
	}
	// URL 里带 ?v=<mediaId>，换头像即换 URL，所以可以长期强缓存。
	c.Header("Cache-Control", "public, max-age=31536000, immutable")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, mime, buf)
}

// MediaAvatarUpload 设置头像（前端已裁剪压缩成方形图片）。
// 只接受图片：头像会被页面上直接内联展示，非图片没有意义且增加风险面。
func MediaAvatarUpload(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	if !services.MediaEnabled() {
		fail(c, http.StatusForbidden, "媒体库功能已关闭", services.MediaCodeDisabled)
		return
	}

	maxBytes := services.AvatarMaxBytes()
	header, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, "缺少头像内容", "no_file")
		return
	}
	if header.Size > maxBytes {
		fail(c, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("头像过大：上限 %dKB（前端应先裁剪压缩）", maxBytes>>10), services.MediaCodeTooLarge)
		return
	}
	buf, err := readUploadLimited(header, maxBytes)
	if err != nil {
		if errors.Is(err, errUploadTooLarge) {
			fail(c, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("头像过大：上限 %dKB（前端应先裁剪压缩）", maxBytes>>10), services.MediaCodeTooLarge)
			return
		}
		fail(c, http.StatusBadRequest, "读取上传文件失败", "read_failed")
		return
	}

	saved, err := services.SaveBuffer(services.SaveMediaInput{
		Buffer:   buf,
		UserID:   user.ID,
		OrigName: "avatar",
		Source:   "avatar",
	})
	if err != nil {
		mediaFail(c, err)
		return
	}
	row, err := services.GetMedia(saved.ID)
	if err != nil || row == nil {
		fail(c, http.StatusInternalServerError, "保存头像失败，请稍后重试", "server_error")
		return
	}
	if row.UserID != user.ID {
		fail(c, http.StatusForbidden, "只能使用自己上传的文件作为头像", "forbidden")
		return
	}
	if row.Kind != services.MediaKindImage {
		fail(c, http.StatusBadRequest, "头像必须是图片", "invalid_avatar")
		return
	}

	refID := strconv.FormatInt(user.ID, 10)
	var oldID int64
	if err := db.DB.QueryRow("SELECT avatar_media_id FROM users WHERE id = ?", user.ID).Scan(&oldID); err != nil {
		oldID = 0
	}
	if oldID != 0 && oldID != row.ID {
		if _, err := services.ReleaseRefs("avatar", []string{refID}); err != nil {
			log.Printf("[media] 释放旧头像引用失败: %v", err)
		}
	}
	if err := services.AttachRef(row.ID, "avatar", refID, "avatar", user.ID); err != nil {
		log.Printf("[media] 绑定头像引用失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存头像失败，请稍后重试", "server_error")
		return
	}

	avatarURL := fmt.Sprintf("/api/media/avatar/%d?v=%d", user.ID, row.ID)
	if _, err := exec(
		"UPDATE users SET avatar_media_id = ?, avatar_url = ? WHERE id = ?",
		row.ID, avatarURL, user.ID,
	); err != nil {
		log.Printf("[media] 更新头像失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存头像失败，请稍后重试", "server_error")
		return
	}
	ok(c, gin.H{"avatar_url": avatarURL})
}

// MediaAvatarDelete 移除自定义头像。
//
// 语义是「撤销上传」而不是「不要头像」：如果这个账号有三方登录绑定的头像，
// 移除自定义头像后回退到平台头像（恢复上传前的状态）；没有平台头像时
// 回退为空串，前端显示姓名首字母。
func MediaAvatarDelete(c *gin.Context) {
	user, logged := currentUser(c)
	if !logged {
		fail(c, http.StatusUnauthorized, "未登录", "unauthorized")
		return
	}
	if _, err := services.ReleaseRefs("avatar", []string{strconv.FormatInt(user.ID, 10)}); err != nil {
		log.Printf("[media] 释放头像引用失败: %v", err)
	}

	// 三方绑定里存着平台头像，取第一张作为回退。
	fallback := ""
	_ = db.DB.QueryRow(
		"SELECT avatar_url FROM user_oauth WHERE user_id = ? AND avatar_url <> '' LIMIT 1",
		user.ID,
	).Scan(&fallback)

	if _, err := exec("UPDATE users SET avatar_media_id = 0, avatar_url = ? WHERE id = ?", fallback, user.ID); err != nil {
		log.Printf("[media] 清除头像失败: %v", err)
		fail(c, http.StatusInternalServerError, "移除头像失败，请稍后重试", "server_error")
		return
	}
	ok(c, gin.H{"avatar_url": fallback, "message": "头像已移除"})
}

// ---------------------------------------------------------------------------
// 回收（管理员）
// ---------------------------------------------------------------------------

// MediaGC 手动触发一轮回收。
func MediaGC(c *gin.Context) {
	if !isMediaAdmin(c) {
		fail(c, http.StatusForbidden, "没有执行该操作的权限", "forbidden")
		return
	}
	var req struct {
		Limit int `json:"limit"`
	}
	_ = c.ShouldBindJSON(&req)
	limit := req.Limit
	if limit < 1 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	res, err := services.RunGC(limit)
	if err != nil {
		log.Printf("[media] 回收失败: %v", err)
		fail(c, http.StatusInternalServerError, "回收失败，请稍后重试", "server_error")
		return
	}
	auditLog(c, "媒体库回收", fmt.Sprintf("标记待删 %d 个、物理清理 %d 个", res.SoftDeleted, res.Purged))
	ok(c, gin.H{"soft_deleted": res.SoftDeleted, "purged": res.Purged})
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

func mediaIDParam(c *gin.Context) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	return n
}

// mediaIntQuery 解析整型查询参数并夹在 [min,max]；解析不了返回 def。
// 必须走解析而不是直接拼进 SQL：`Number("Infinity")` 这类脏值会让查询报错成 500。
func mediaIntQuery(raw string, def, min, max int) int {
	n, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return def
	}
	if n < min {
		return min
	}
	if n > max {
		return max
	}
	return n
}
