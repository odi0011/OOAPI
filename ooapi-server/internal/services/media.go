package services

/*
媒体库：统一文件存储（内容寻址 + 元数据行 + 引用表）。

为什么要有它：此前对话图片是把 base64 直接写进消息体（MEDIUMTEXT）——
大图会让整轮对话落库失败或静默截断，每轮对话还要把图片全量拉出来解析；
用户头像、社区发帖图又各做一套。这里统一收口：

  · 物理文件按 sha256 落盘、两级分片，同一字节全局只存一份；
  · media 表一行 = 某用户的某个文件（含大小、尺寸、引用计数）；
  · media_refs 记录「谁在引用它」，删除链路据此释放，避免死链与孤儿文件。

零新增依赖：sha256 用标准库，类型/尺寸嗅探自己解析文件头。
*/
import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ooapi/internal/db"
)

// ---------------------------------------------------------------------------
// 存储根目录
// ---------------------------------------------------------------------------

var (
	mediaRootMu       sync.RWMutex
	mediaRootOverride string
)

// SetMediaRoot 覆盖媒体存储根目录（测试用）。
// 传入空串恢复默认值：工作目录下的 data/media（与 uploads/ 同级）。
func SetMediaRoot(dir string) {
	mediaRootMu.Lock()
	mediaRootOverride = dir
	mediaRootMu.Unlock()
}

// MediaRoot 返回媒体存储根目录。
func MediaRoot() string {
	mediaRootMu.RLock()
	defer mediaRootMu.RUnlock()
	if mediaRootOverride != "" {
		return mediaRootOverride
	}
	return filepath.Join("data", "media")
}

// MediaBlobPath 返回 blob 的磁盘路径：前 2 位 / 次 2 位分片，避免单目录文件过多。
func MediaBlobPath(sha, ext string) string {
	if len(sha) < 4 {
		name := sha
		if ext != "" {
			name = sha + "." + ext
		}
		return filepath.Join(MediaRoot(), "blobs", name)
	}
	name := sha
	if ext != "" {
		name = sha + "." + ext
	}
	return filepath.Join(MediaRoot(), "blobs", sha[:2], sha[2:4], name)
}

var mediaTmpCleanOnce sync.Once

// ensureMediaDirs 确保 blobs/tmp 目录存在（惰性调用：上传时兜底）。
// 进程内第一次调用时顺手清空 tmp —— 上次崩溃可能留下半截文件。
func ensureMediaDirs() error {
	blobs := filepath.Join(MediaRoot(), "blobs")
	tmp := filepath.Join(MediaRoot(), "tmp")
	if err := os.MkdirAll(blobs, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	mediaTmpCleanOnce.Do(func() { cleanMediaTmp(tmp) })
	return nil
}

func cleanMediaTmp(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}

// ---------------------------------------------------------------------------
// 类型嗅探（按文件头，不信任前端给的 MIME 与扩展名）
// ---------------------------------------------------------------------------

// MediaType 是一次嗅探结果。
type MediaType struct {
	Ext  string `json:"ext"`
	Mime string `json:"mime"`
	Kind string `json:"kind"`
}

// 允许的类型白名单。
//
// 刻意不含 SVG：SVG 可内嵌脚本，从本站源 inline 出去等于存储型 XSS。
// 由于 SVG 是文本、会被「纯文本」探测误收，SniffMedia 里额外显式拒绝它。
var mediaMagic = []struct {
	ext  string
	mime string
	kind string
	test func([]byte) bool
}{
	{"png", "image/png", MediaKindImage, func(b []byte) bool {
		return len(b) > 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G'
	}},
	{"jpg", "image/jpeg", MediaKindImage, func(b []byte) bool {
		return len(b) > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff
	}},
	{"gif", "image/gif", MediaKindImage, func(b []byte) bool {
		return len(b) > 6 && string(b[:3]) == "GIF"
	}},
	{"webp", "image/webp", MediaKindImage, func(b []byte) bool {
		return len(b) > 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP"
	}},
	{"pdf", "application/pdf", MediaKindFile, func(b []byte) bool {
		return len(b) > 5 && string(b[:5]) == "%PDF-"
	}},
	// 纯文本类（对话里的文档上传）：没有魔数，用「可打印字符占比」判定。
	{"txt", "text/plain", MediaKindFile, func(b []byte) bool { return IsProbablyText(b) }},
}

// SniffMedia 按文件头嗅探类型；识别不了返回 false（拒绝入库，而不是猜一个扩展名）。
func SniffMedia(buf []byte) (MediaType, bool) {
	if looksLikeSVG(buf) {
		// 显式拒绝：文本探测会把它当 text/plain 收下，而 SVG 一旦内联即 XSS。
		return MediaType{}, false
	}
	for _, m := range mediaMagic {
		if m.test(buf) {
			return MediaType{Ext: m.ext, Mime: m.mime, Kind: m.kind}, true
		}
	}
	return MediaType{}, false
}

// looksLikeSVG 检查前 4KB 是否像 SVG（含 XML 声明或 <svg 标签）。
// 宁可错杀纯文本里的 "<svg" 字样，也不放过一个可执行脚本的矢量图。
func looksLikeSVG(buf []byte) bool {
	n := len(buf)
	if n > 4096 {
		n = 4096
	}
	head := strings.ToLower(string(buf[:n]))
	head = strings.TrimPrefix(head, "\ufeff")
	return strings.Contains(head, "<svg")
}

// IsProbablyText 判断前 4KB 的可打印字符占比是否 > 95% 且不含 NUL。
func IsProbablyText(buf []byte) bool {
	n := len(buf)
	if n == 0 {
		return false
	}
	if n > 4096 {
		n = 4096
	}
	printable := 0
	for i := 0; i < n; i++ {
		c := buf[i]
		if c == 0 {
			return false
		}
		// 允许 \t \n \r 与 0x20 以上（UTF-8 多字节的高位字节也放行）。
		if c == 9 || c == 10 || c == 13 || (c >= 0x20 && c != 0x7f) {
			printable++
		}
	}
	return float64(printable)/float64(n) > 0.95
}

// ---------------------------------------------------------------------------
// 图片尺寸（零依赖解析文件头）
// ---------------------------------------------------------------------------

// MaxImageDim 是宽高的合理上限（像素）。
// 畸形文件的 IHDR 可以是任意 32 位值，直接写库会撞列宽限制并把 MySQL 原始
// 报错吐给用户；真实图片没有超过这个尺寸的（100000² = 100 亿像素）。
const MaxImageDim = 100000

func clampDim(v int) int {
	if v > 0 && v <= MaxImageDim {
		return v
	}
	return 0
}

// ImageSize 解析 PNG / JPEG / GIF / WebP 的宽高；解析不了返回 0, 0。
func ImageSize(buf []byte, ext string) (int, int) {
	switch ext {
	case "png":
		if len(buf) > 24 {
			return clampDim(int(be32(buf, 16))), clampDim(int(be32(buf, 20)))
		}
	case "gif":
		if len(buf) > 10 {
			return clampDim(int(le16(buf, 6))), clampDim(int(le16(buf, 8)))
		}
	case "webp":
		if len(buf) > 30 {
			// VP8X（扩展格式）：宽高在 24..29，各 3 字节（值 - 1）。
			if string(buf[12:16]) == "VP8X" {
				w := 1 + (int(buf[24]) | int(buf[25])<<8 | int(buf[26])<<16)
				h := 1 + (int(buf[27]) | int(buf[28])<<8 | int(buf[29])<<16)
				return clampDim(w), clampDim(h)
			}
			// VP8（有损）：帧头在 26 起，宽高各 2 字节（低 14 位）。
			if string(buf[12:15]) == "VP8" {
				return clampDim(int(le16(buf, 26)) & 0x3fff), clampDim(int(le16(buf, 28)) & 0x3fff)
			}
		}
	case "jpg", "jpeg":
		// 顺序扫描 SOF 段；限制迭代次数防止畸形文件造成长循环。
		i := 2
		for guard := 0; i+9 < len(buf) && guard < 1000; guard++ {
			if buf[i] != 0xff {
				i++
				continue
			}
			marker := buf[i+1]
			// SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
			// SOF 段里高在前、宽在后：i+5 是高度，i+7 是宽度。
			if (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
				(marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf) {
				height := int(be16(buf, i+5))
				width := int(be16(buf, i+7))
				return clampDim(width), clampDim(height)
			}
			length := int(be16(buf, i+2))
			if length < 2 {
				break
			}
			i += 2 + length
		}
	}
	return 0, 0
}

func be16(b []byte, off int) uint16 {
	return uint16(b[off])<<8 | uint16(b[off+1])
}

func be32(b []byte, off int) uint32 {
	return uint32(b[off])<<24 | uint32(b[off+1])<<16 | uint32(b[off+2])<<8 | uint32(b[off+3])
}

func le16(b []byte, off int) uint16 {
	return uint16(b[off]) | uint16(b[off+1])<<8
}

// ---------------------------------------------------------------------------
// 行模型与扫描
// ---------------------------------------------------------------------------

// 媒体状态。
const (
	MediaStatusNormal  = 1 // 正常
	MediaStatusDeleted = 2 // 已软删，保留期后回收
)

// 媒体类别。
const (
	MediaKindImage = "image"
	MediaKindFile  = "file"
)

// MediaRow 是 media 表一行的内存表示。
type MediaRow struct {
	ID           int64      `json:"id"`
	UserID       int64      `json:"user_id"`
	Sha256       string     `json:"sha256"`
	Size         int64      `json:"size"`
	Mime         string     `json:"mime"`
	Kind         string     `json:"kind"`
	Ext          string     `json:"ext"`
	OrigName     string     `json:"orig_name"`
	Source       string     `json:"source"`
	Width        int        `json:"width"`
	Height       int        `json:"height"`
	RefCount     int        `json:"ref_count"`
	Status       int        `json:"status"`
	DeletedAt    *time.Time `json:"deleted_at,omitempty"`
	LastAccessAt *time.Time `json:"last_access_at,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
}

const mediaSelectColumns = `id, user_id, sha256, size, mime, kind, ext, orig_name, source,
	width, height, ref_count, status, deleted_at, last_access_at, created_at`

// scanMediaRow 复用同包里的 rowScanner（*sql.Row 与 *sql.Rows 都满足）。
func scanMediaRow(sc rowScanner) (*MediaRow, error) {
	var m MediaRow
	err := sc.Scan(&m.ID, &m.UserID, &m.Sha256, &m.Size, &m.Mime, &m.Kind, &m.Ext, &m.OrigName,
		&m.Source, &m.Width, &m.Height, &m.RefCount, &m.Status, &m.DeletedAt, &m.LastAccessAt, &m.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// GetMedia 按 id 取一行（不校验权限，调用方负责）。
func GetMedia(id int64) (*MediaRow, error) {
	if id <= 0 {
		return nil, sql.ErrNoRows
	}
	row, err := scanMediaRow(db.DB.QueryRow("SELECT "+mediaSelectColumns+" FROM media WHERE id = ? LIMIT 1", id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	return row, err
}

// ReadBlob 读取文件内容；文件缺失返回错误（调用方转 404 而不是 500）。
func ReadBlob(row *MediaRow) ([]byte, error) {
	if row == nil {
		return nil, errors.New("媒体行为空")
	}
	return os.ReadFile(MediaBlobPath(row.Sha256, row.Ext))
}

// TouchLastAccess 更新最近访问时间（用于识别冷数据；失败不影响下载）。
// 可能被 fire-and-forget 的 goroutine 调用，因此对未初始化连接也要安全返回。
func TouchLastAccess(id int64) error {
	conn := db.DB
	if conn == nil || id <= 0 {
		return nil
	}
	_, err := conn.Exec("UPDATE media SET last_access_at = NOW() WHERE id = ?", id)
	return err
}

// ---------------------------------------------------------------------------
// 设置项
// ---------------------------------------------------------------------------

// 设置键与默认值。默认值写在这里而不是 options 表：
// 设置项未写入时也要有确定行为，否则「没配」会退化成 0 值。
const (
	OptionMediaEnabled        = "media_enabled"
	OptionMediaMaxFileMB      = "media_max_file_mb"
	OptionMediaUserQuotaMB    = "media_user_quota_mb"
	OptionMediaAvatarMaxKB    = "media_avatar_max_kb"
	OptionMediaOrphanHours    = "media_orphan_hours"
	OptionMediaRetentionDays  = "media_retention_days"
	DefaultMediaMaxFileMB     = 10
	DefaultMediaUserQuotaMB   = 1024
	DefaultMediaAvatarMaxKB   = 512
	DefaultMediaOrphanHours   = 24
	DefaultMediaRetentionDays = 7
)

// MediaEnabled 媒体库总开关。
func MediaEnabled() bool { return GetBoolOption(OptionMediaEnabled, true) }

// MaxFileBytes 单文件上限（字节）。
func MaxFileBytes() int64 {
	mb := GetIntOption(OptionMediaMaxFileMB, DefaultMediaMaxFileMB)
	if mb <= 0 {
		mb = DefaultMediaMaxFileMB
	}
	return int64(mb) << 20
}

// QuotaBytes 单用户配额（字节）；0 = 不限。
func QuotaBytes() int64 {
	mb := GetIntOption(OptionMediaUserQuotaMB, DefaultMediaUserQuotaMB)
	if mb <= 0 {
		return 0
	}
	return int64(mb) << 20
}

// AvatarMaxBytes 头像上限（字节）。
func AvatarMaxBytes() int64 {
	kb := GetIntOption(OptionMediaAvatarMaxKB, DefaultMediaAvatarMaxKB)
	if kb <= 0 {
		kb = DefaultMediaAvatarMaxKB
	}
	return int64(kb) << 10
}

// OrphanHours 未引用文件在多少小时后进入软删；0 = 不回收。
func OrphanHours() int { return GetIntOption(OptionMediaOrphanHours, DefaultMediaOrphanHours) }

// RetentionDays 软删后保留天数；0 = 不自动物理回收。
func RetentionDays() int { return GetIntOption(OptionMediaRetentionDays, DefaultMediaRetentionDays) }

// ---------------------------------------------------------------------------
// 上传：去重 + 落盘 + 建行
// ---------------------------------------------------------------------------

// 业务错误码：handler 据此映射 HTTP 状态，前端据此给具体提示。
const (
	MediaCodeDisabled = "MEDIA_DISABLED"
	MediaCodeEmpty    = "MEDIA_EMPTY"
	MediaCodeTooLarge = "MEDIA_TOO_LARGE"
	MediaCodeType     = "MEDIA_TYPE"
	MediaCodeQuota    = "MEDIA_QUOTA"
)

// MediaError 是带业务码的媒体错误。
type MediaError struct {
	Code    string
	Message string
}

func (e *MediaError) Error() string { return e.Message }

func mediaError(code, format string, args ...any) *MediaError {
	return &MediaError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// MediaErrorCode 提取业务码；非媒体错误返回空串。
func MediaErrorCode(err error) string {
	var me *MediaError
	if errors.As(err, &me) {
		return me.Code
	}
	return ""
}

// MediaErrorMessage 提取可展示的错误文案。
func MediaErrorMessage(err error) string {
	var me *MediaError
	if errors.As(err, &me) {
		return me.Message
	}
	return "保存文件失败"
}

// 上传来源白名单。
var mediaSources = map[string]struct{}{
	"upload": {}, "avatar": {}, "post": {}, "chat": {}, "community": {}, "admin": {},
}

// NormalizeMediaSource 归一化上传来源；未知来源回退 upload。
func NormalizeMediaSource(s string) string {
	v := strings.ToLower(strings.TrimSpace(s))
	if _, ok := mediaSources[v]; ok {
		return v
	}
	return "upload"
}

// SaveMediaInput 是一次上传的输入。
type SaveMediaInput struct {
	Buffer   []byte
	UserID   int64
	OrigName string
	Source   string
}

// SavedMedia 是一次上传的结果。
type SavedMedia struct {
	ID      int64  `json:"id"`
	Sha256  string `json:"sha256"`
	Size    int64  `json:"size"`
	Mime    string `json:"mime"`
	Kind    string `json:"kind"`
	Ext     string `json:"ext"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Deduped bool   `json:"deduped"`
}

// SaveBuffer 保存一个文件（去重 + 落盘 + 建行）。
//
// 去重键是 (user_id, sha256)：同一用户同一内容只保留一行；
// 命中软删行则复活（否则唯一键冲突），命中活行直接复用并标记 deduped。
func SaveBuffer(in SaveMediaInput) (*SavedMedia, error) {
	if !MediaEnabled() {
		return nil, mediaError(MediaCodeDisabled, "媒体库功能已关闭")
	}
	if db.DB == nil {
		return nil, errors.New("数据库未初始化")
	}
	buf := in.Buffer
	if len(buf) == 0 {
		return nil, mediaError(MediaCodeEmpty, "文件内容为空")
	}

	max := MaxFileBytes()
	if int64(len(buf)) > max {
		return nil, mediaError(MediaCodeTooLarge, "文件过大：%.1fMB，上限 %dMB",
			float64(len(buf))/1048576, max>>20)
	}

	mt, ok := SniffMedia(buf)
	if !ok {
		return nil, mediaError(MediaCodeType, "不支持的文件类型（支持 PNG/JPEG/GIF/WebP/PDF/纯文本）")
	}

	sum := sha256.Sum256(buf)
	sha := hex.EncodeToString(sum[:])
	uid := in.UserID

	// 先查去重行：既决定是否复活，也决定配额是否豁免（同内容不占额外空间）。
	var existID int64
	var existStatus int
	err := db.DB.QueryRow(
		"SELECT id, status FROM media WHERE user_id = ? AND sha256 = ? LIMIT 1", uid, sha,
	).Scan(&existID, &existStatus)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if errors.Is(err, sql.ErrNoRows) {
		existID = 0
	}

	if quota := QuotaBytes(); quota > 0 && existID == 0 {
		used, uerr := UsedBytes(uid)
		if uerr != nil {
			return nil, uerr
		}
		if used+int64(len(buf)) > quota {
			return nil, mediaError(MediaCodeQuota, "存储配额不足：已用 %.1fMB / 上限 %dMB",
				float64(used)/1048576, quota>>20)
		}
	}

	// 先写临时文件再 rename：同分区 rename 是原子的，
	// 避免「文件写一半就被引用」以及并发写同一路径互相覆盖。
	if err := writeBlobAtomic(buf, MediaBlobPath(sha, mt.Ext)); err != nil {
		return nil, err
	}

	width, height := 0, 0
	if mt.Kind == MediaKindImage {
		width, height = ImageSize(buf, mt.Ext)
	}

	if existID != 0 {
		if existStatus != MediaStatusNormal {
			// 复活软删行：刷新嗅探结果（扩展名/类型可能因探测规则升级而变化）。
			if _, err := db.DB.Exec(
				`UPDATE media SET status = ?, deleted_at = NULL, size = ?, mime = ?, kind = ?, ext = ?, width = ?, height = ?
				 WHERE id = ?`,
				MediaStatusNormal, len(buf), mt.Mime, mt.Kind, mt.Ext, width, height, existID,
			); err != nil {
				return nil, err
			}
		}
		return &SavedMedia{
			ID: existID, Sha256: sha, Size: int64(len(buf)), Mime: mt.Mime,
			Kind: mt.Kind, Ext: mt.Ext, Width: width, Height: height, Deduped: true,
		}, nil
	}

	res, err := db.DB.Exec(
		`INSERT INTO media (user_id, sha256, size, mime, kind, ext, orig_name, source, width, height, ref_count, status)
		 VALUES (?,?,?,?,?,?,?,?,?,?,0,1)`,
		uid, sha, len(buf), mt.Mime, mt.Kind, mt.Ext,
		truncateRunes(strings.TrimSpace(in.OrigName), 255), NormalizeMediaSource(in.Source),
		width, height,
	)
	if err != nil {
		// 并发上传同一内容：唯一键冲突时回退成「去重命中」而不是把错误抛给用户。
		if isDuplicateKeyErr(err) {
			var dupID int64
			if qerr := db.DB.QueryRow(
				"SELECT id FROM media WHERE user_id = ? AND sha256 = ? LIMIT 1", uid, sha,
			).Scan(&dupID); qerr == nil {
				return &SavedMedia{
					ID: dupID, Sha256: sha, Size: int64(len(buf)), Mime: mt.Mime,
					Kind: mt.Kind, Ext: mt.Ext, Width: width, Height: height, Deduped: true,
				}, nil
			}
		}
		return nil, err
	}

	id, _ := res.LastInsertId()
	return &SavedMedia{
		ID: id, Sha256: sha, Size: int64(len(buf)), Mime: mt.Mime,
		Kind: mt.Kind, Ext: mt.Ext, Width: width, Height: height, Deduped: false,
	}, nil
}

// writeBlobAtomic 原子落盘。目标已存在说明内容相同（内容寻址），直接丢弃临时文件。
func writeBlobAtomic(buf []byte, target string) error {
	// ensureMediaDirs 还负责首次调用时清理上次崩溃可能留下的半截临时文件。
	if err := ensureMediaDirs(); err != nil {
		return err
	}
	return writeBlobAtomicTo(MediaRoot(), buf, target)
}

// writeBlobAtomicTo 与 writeBlobAtomic 同逻辑，但显式指定临时目录所属的根，
// 测试可据此把落盘限制在临时目录内。
func writeBlobAtomicTo(root string, buf []byte, target string) error {
	tmpDir := filepath.Join(root, "tmp")
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(tmpDir, "media-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	if _, err := os.Stat(target); err == nil {
		// 已存在：同 sha 内容必然相同，无需覆盖。
		return nil
	}
	if err := os.Rename(tmpName, target); err != nil {
		// 跨设备/并发覆盖等场景退回「复制 + 删临时」。
		if cerr := copyFile(tmpName, target); cerr != nil {
			return err
		}
		_ = os.Remove(tmpName)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func isDuplicateKeyErr(err error) bool {
	s := err.Error()
	return strings.Contains(s, "Duplicate entry") || strings.Contains(s, "1062")
}

// ---------------------------------------------------------------------------
// 配额与统计
// ---------------------------------------------------------------------------

// UsedBytes 用户当前已用字节数（软删行不占配额）。
func UsedBytes(userID int64) (int64, error) {
	var n int64
	err := db.DB.QueryRow(
		"SELECT COALESCE(SUM(size),0) FROM media WHERE user_id = ? AND status <> ?",
		userID, MediaStatusDeleted,
	).Scan(&n)
	return n, err
}

// MediaKindStat 按类别的统计。
type MediaKindStat struct {
	Kind  string `json:"kind"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

// MediaStats 是用户或全站统计。
type MediaStats struct {
	Count  int64           `json:"count"`
	Bytes  int64           `json:"bytes"`
	ByKind []MediaKindStat `json:"by_kind"`
}

const mediaKindAggQuery = `SELECT kind, COUNT(*), COALESCE(SUM(size),0) FROM media WHERE %s GROUP BY kind ORDER BY kind`

func queryMediaStats(where string, args ...any) (*MediaStats, error) {
	out := &MediaStats{ByKind: []MediaKindStat{}}
	if err := db.DB.QueryRow(
		"SELECT COUNT(*), COALESCE(SUM(size),0) FROM media WHERE "+where, args...,
	).Scan(&out.Count, &out.Bytes); err != nil {
		return nil, err
	}
	rows, err := db.DB.Query(fmt.Sprintf(mediaKindAggQuery, where), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k MediaKindStat
		if err := rows.Scan(&k.Kind, &k.Count, &k.Bytes); err != nil {
			return nil, err
		}
		out.ByKind = append(out.ByKind, k)
	}
	return out, rows.Err()
}

// UserStats 某个用户的统计。
func UserStats(userID int64) (*MediaStats, error) {
	return queryMediaStats("user_id = ? AND status <> ?", userID, MediaStatusDeleted)
}

// AllStats 全站统计。
func AllStats() (*MediaStats, error) {
	return queryMediaStats("status <> ?", MediaStatusDeleted)
}

// ---------------------------------------------------------------------------
// 引用表
// ---------------------------------------------------------------------------

// MediaRef 是一条活引用。
type MediaRef struct {
	RefType string `json:"ref_type"`
	RefID   string `json:"ref_id"`
}

// AttachRef 绑定引用：谁在用这个文件（同一对象同一位置幂等，重复引用走复活）。
func AttachRef(mediaID int64, refType, refID, slot string, userID int64) error {
	if mediaID <= 0 {
		return nil
	}
	if db.DB == nil {
		return errors.New("数据库未初始化")
	}
	_, err := db.DB.Exec(
		`INSERT INTO media_refs (media_id, user_id, ref_type, ref_id, slot, is_live)
		 VALUES (?,?,?,?,?,1)
		 ON DUPLICATE KEY UPDATE is_live = 1, updated_at = NOW()`,
		mediaID, userID, truncateBytes(refType, 24), truncateBytes(refID, 64), truncateBytes(slot, 24),
	)
	if err != nil {
		return err
	}
	return RecountRefs([]int64{mediaID})
}

// ReleaseRefs 解绑某个对象（如一条消息、一个用户头像）的全部引用，软删 is_live=0 保留审计线索。
func ReleaseRefs(refType string, refIDs []string) (int64, error) {
	ids := uniqueStrings(refIDs)
	if len(ids) == 0 {
		return 0, nil
	}
	ph, args := placeholderList(ids)

	rows, err := db.DB.Query(
		"SELECT DISTINCT media_id FROM media_refs WHERE ref_type = ? AND ref_id IN ("+ph+") AND is_live = 1",
		append([]any{refType}, args...)...,
	)
	if err != nil {
		return 0, err
	}
	var mediaIDs []int64
	for rows.Next() {
		var mid int64
		if err := rows.Scan(&mid); err != nil {
			rows.Close()
			return 0, err
		}
		mediaIDs = append(mediaIDs, mid)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	res, err := db.DB.Exec(
		"UPDATE media_refs SET is_live = 0, updated_at = NOW() WHERE ref_type = ? AND ref_id IN ("+ph+") AND is_live = 1",
		append([]any{refType}, args...)...,
	)
	if err != nil {
		return 0, err
	}
	affected, _ := res.RowsAffected()
	if err := RecountRefs(mediaIDs); err != nil {
		return affected, err
	}
	return affected, nil
}

// ReleaseMediaRefs 解绑某个媒体行上的全部活引用（管理员强制删除时用，避免留下死链）。
func ReleaseMediaRefs(mediaID int64) (int64, error) {
	if mediaID <= 0 {
		return 0, nil
	}
	res, err := db.DB.Exec(
		"UPDATE media_refs SET is_live = 0, updated_at = NOW() WHERE media_id = ? AND is_live = 1", mediaID,
	)
	if err != nil {
		return 0, err
	}
	affected, _ := res.RowsAffected()
	if err := RecountRefs([]int64{mediaID}); err != nil {
		return affected, err
	}
	return affected, nil
}

// LiveRefs 返回某媒体的活引用（删除被拒时告诉用户「还被谁引用着」）。
func LiveRefs(mediaID int64, limit int) ([]MediaRef, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := db.DB.Query(
		"SELECT ref_type, ref_id FROM media_refs WHERE media_id = ? AND is_live = 1 LIMIT ?", mediaID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MediaRef{}
	for rows.Next() {
		var r MediaRef
		if err := rows.Scan(&r.RefType, &r.RefID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// RecountRefs 重算引用计数（只算给定的 media id，避免全表扫描）。
//
// 用一条多表 UPDATE 完成：派生表统计活引用数，LEFT JOIN 到 media 后写回。
// 计数永远由引用表现算，不靠自增自减 —— 并发下自增自减会漂移。
func RecountRefs(mediaIDs []int64) error {
	ids := uniqueInt64(mediaIDs)
	if len(ids) == 0 {
		return nil
	}
	ph, args := placeholderList(ids)
	all := append(append([]any{}, args...), args...)
	_, err := db.DB.Exec(
		`UPDATE media m
		   LEFT JOIN (SELECT media_id, COUNT(*) AS c FROM media_refs
		               WHERE is_live = 1 AND media_id IN (`+ph+`) GROUP BY media_id) r
		          ON r.media_id = m.id
		    SET m.ref_count = COALESCE(r.c, 0)
		  WHERE m.id IN (`+ph+`)`,
		all...,
	)
	return err
}

// ---------------------------------------------------------------------------
// 回收
// ---------------------------------------------------------------------------

// GCResult 一轮回收的结果。
type GCResult struct {
	SoftDeleted int64 `json:"soft_deleted"`
	Purged      int64 `json:"purged"`
}

// RunGC 回收一轮：
//  1. 无引用且超过 orphan_hours 的新上传 → 软删（0 = 不回收）；
//  2. 软删且超过 retention_days 的 → 物理删文件与数据行（0 = 不自动回收）。
//
// 物理删除前必须跨用户查重：同一 sha 可能被别的用户共享，误删会影响别人。
func RunGC(limit int) (GCResult, error) {
	var out GCResult
	if db.DB == nil {
		return out, errors.New("数据库未初始化")
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	now := time.Now()

	if hours := OrphanHours(); hours > 0 {
		res, err := db.DB.Exec(
			"UPDATE media SET status = ?, deleted_at = ? WHERE status = 1 AND ref_count = 0 AND created_at < ? LIMIT ?",
			MediaStatusDeleted, now, now.Add(-time.Duration(hours)*time.Hour), limit,
		)
		if err != nil {
			return out, err
		}
		out.SoftDeleted, _ = res.RowsAffected()
	}

	days := RetentionDays()
	if days <= 0 {
		return out, nil
	}

	rows, err := db.DB.Query(
		"SELECT id, sha256, ext FROM media WHERE status = ? AND deleted_at IS NOT NULL AND deleted_at < ? LIMIT ?",
		MediaStatusDeleted, now.Add(-time.Duration(days)*24*time.Hour), limit,
	)
	if err != nil {
		return out, err
	}
	type victim struct {
		id  int64
		sha string
		ext string
	}
	var victims []victim
	for rows.Next() {
		var v victim
		if err := rows.Scan(&v.id, &v.sha, &v.ext); err != nil {
			rows.Close()
			return out, err
		}
		victims = append(victims, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	for _, v := range victims {
		var other int64
		if err := db.DB.QueryRow(
			"SELECT COUNT(*) FROM media WHERE sha256 = ? AND status <> ? AND id <> ?",
			v.sha, MediaStatusDeleted, v.id,
		).Scan(&other); err == nil && other == 0 {
			_ = os.Remove(MediaBlobPath(v.sha, v.ext))
		}
		_, _ = db.DB.Exec("DELETE FROM media_refs WHERE media_id = ?", v.id)
		_, _ = db.DB.Exec("DELETE FROM media WHERE id = ?", v.id)
		out.Purged++
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// 签名 URL
// ---------------------------------------------------------------------------

// MediaSignTTL 是下载签名的默认有效期。
//
// 聊天消息里的 <img> 带不了 Authorization 头，所以读取走「签名 query」：
// HMAC(JWT_SECRET) 对 mediaId 与过期时间签名。签名不落库、由服务端每次序列化
// 时现签 —— 链接即凭据，id 是自增但配合 HMAC 无法枚举。
const MediaSignTTL = 7 * 24 * time.Hour

func mediaSign(id, exp int64) string {
	mac := hmac.New(sha256.New, []byte(JWTSecret()))
	fmt.Fprintf(mac, "%d.%d", id, exp)
	return hex.EncodeToString(mac.Sum(nil))[:32]
}

// SignMediaTTL 生成带自定义有效期的签名（测试与内部使用）。
// ttl 为负表示已过期，用于验证过期判定。
func SignMediaTTL(id int64, ttl time.Duration) string {
	if ttl == 0 {
		ttl = MediaSignTTL
	}
	exp := time.Now().Unix() + int64(ttl/time.Second)
	return strconv.FormatInt(exp, 10) + "." + mediaSign(id, exp)
}

// SignMedia 生成默认 7 天有效期的签名。
func SignMedia(id int64) string { return SignMediaTTL(id, MediaSignTTL) }

// VerifyMediaSign 校验签名。过期、格式错、被篡改一律判否；
// 比较用定时安全算法，避免通过响应时间猜签名。
func VerifyMediaSign(id int64, sig string) bool {
	dot := strings.Index(sig, ".")
	if dot <= 0 {
		return false
	}
	exp, err := strconv.ParseInt(sig[:dot], 10, 64)
	if err != nil || exp < time.Now().Unix() {
		return false
	}
	expect := mediaSign(id, exp)
	return subtle.ConstantTimeCompare([]byte(sig[dot+1:]), []byte(expect)) == 1
}

// MediaURL 对外 URL（带签名，可直接放进 <img src>）。
func MediaURL(id int64) string {
	if id <= 0 {
		return ""
	}
	return fmt.Sprintf("/api/media/%d/raw?s=%s", id, url.QueryEscape(SignMedia(id)))
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

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

// truncateBytes 截断到不超过 max 字节（用于列宽有限的 ASCII 字段）。
func truncateBytes(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func uniqueStrings(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

func uniqueInt64(in []int64) []int64 {
	seen := map[int64]struct{}{}
	out := make([]int64, 0, len(in))
	for _, v := range in {
		if v <= 0 {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

func placeholderList[T any](items []T) (string, []any) {
	args := make([]any, 0, len(items))
	for _, v := range items {
		args = append(args, v)
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(items)), ",")
	return ph, args
}
