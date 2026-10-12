package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"ooapi/internal/services"
)

// 上传文件的存放目录。相对 WEB_DIR 的上层，避免混进前端构建产物里
// （前端每次构建都会清空 web/，上传的文件会被一起删掉）。
const uploadDir = "uploads"

// 允许的图标类型。只收图片：SVG 与位图。
// 不接受任意文件，避免被当成文件中转站。
var allowedIconExt = map[string]string{
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico":  "image/x-icon",
}

// 单文件大小上限。图标类资源不需要很大，1MB 足够。
const maxIconSize = 1 << 20

// AdminUploadIcon 上传站点或货币图标，需要 option:edit。
//
// 用 multipart 文件上传，而不是让管理员手填图片地址 ——
// 填地址要求对方先把图片传到别处，多一步且容易填错。
func AdminUploadIcon(c *gin.Context) {
	kind := strings.TrimSpace(c.PostForm("kind"))
	if kind != "logo" && kind != "currency" {
		fail(c, http.StatusBadRequest, "上传类型只能是 logo 或 currency", "invalid_kind")
		return
	}

	header, err := c.FormFile("file")
	if err != nil {
		fail(c, http.StatusBadRequest, "请选择要上传的文件", "no_file")
		return
	}

	if header.Size > maxIconSize {
		fail(c, http.StatusBadRequest, fmt.Sprintf("文件不能超过 %d KB", maxIconSize/1024), "file_too_large")
		return
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	if _, ok := allowedIconExt[ext]; !ok {
		fail(c, http.StatusBadRequest, "只支持 SVG、PNG、JPG、WebP、ICO 格式", "invalid_type")
		return
	}

	src, err := header.Open()
	if err != nil {
		fail(c, http.StatusInternalServerError, "读取上传文件失败", "read_failed")
		return
	}
	defer src.Close()

	// 读前 512 字节做内容嗅探。仅靠扩展名校验不够 ——
	// 把任意文件改名为 .png 就能绕过，而网站图标会被直接下发到访问者浏览器。
	head := make([]byte, 512)
	n, _ := io.ReadFull(src, head)
	head = head[:n]

	if err := verifyImageContent(ext, head); err != nil {
		fail(c, http.StatusBadRequest, err.Error(), "invalid_content")
		return
	}

	// 重置读取位置，把完整内容写出去。
	if _, err := src.Seek(0, io.SeekStart); err != nil {
		fail(c, http.StatusInternalServerError, "读取上传文件失败", "read_failed")
		return
	}

	// 文件名用随机值：避免管理员上传的两个同名文件互相覆盖，
	// 也避免文件名里带路径穿越字符。
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		fail(c, http.StatusInternalServerError, "生成文件名失败", "server_error")
		return
	}
	filename := kind + "-" + hex.EncodeToString(buf) + ext

	dir := filepath.Join(services.UploadRoot(), kind)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[upload] 创建目录失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存文件失败", "server_error")
		return
	}

	dst := filepath.Join(dir, filename)
	out, err := os.Create(dst)
	if err != nil {
		log.Printf("[upload] 创建文件失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存文件失败", "server_error")
		return
	}
	defer out.Close()

	written, err := io.Copy(out, io.LimitReader(src, maxIconSize))
	if err != nil {
		log.Printf("[upload] 写入失败: %v", err)
		fail(c, http.StatusInternalServerError, "保存文件失败", "server_error")
		return
	}
	if written == 0 {
		fail(c, http.StatusBadRequest, "文件内容为空", "empty_file")
		return
	}

	// 对外地址走 /uploads/ 前缀，由 router 托管该目录。
	url := "/uploads/" + kind + "/" + filename

	// 顺手把设置里的地址更新掉，省得管理员上传后还要再点一次保存。
	key := "logo"
	if kind == "currency" {
		key = "currency_icon"
	}
	if err := services.SetOptions(map[string]string{key: url}); err != nil {
		log.Printf("[upload] 更新设置失败: %v", err)
	}

	operator, _ := currentUser(c)
	if operator != nil {
		log.Printf("[upload] %s 上传了 %s 图标: %s", operator.Username, kind, url)
	}

	ok(c, gin.H{"url": url, "kind": kind, "size": written})
}

// verifyImageContent 按扩展名校验文件头，挡住改名的非图片文件。
func verifyImageContent(ext string, head []byte) error {
	if len(head) == 0 {
		return fmt.Errorf("文件内容为空")
	}

	switch ext {
	case ".svg":
		// SVG 是文本，检查是否以 XML/SVG 开头。
		// 注意：SVG 可内嵌脚本，因此这里也拒绝含 <script> 的文件。
		s := strings.ToLower(string(head))
		trimmed := strings.TrimSpace(s)
		if !strings.HasPrefix(trimmed, "<?xml") && !strings.HasPrefix(trimmed, "<svg") {
			return fmt.Errorf("这不是有效的 SVG 文件")
		}
		if strings.Contains(s, "<script") || strings.Contains(s, "javascript:") {
			return fmt.Errorf("SVG 中含有脚本，出于安全考虑已拒绝")
		}
	case ".png":
		if len(head) < 8 || string(head[1:4]) != "PNG" {
			return fmt.Errorf("这不是有效的 PNG 文件")
		}
	case ".jpg", ".jpeg":
		if len(head) < 3 || head[0] != 0xFF || head[1] != 0xD8 || head[2] != 0xFF {
			return fmt.Errorf("这不是有效的 JPEG 文件")
		}
	case ".webp":
		if len(head) < 12 || string(head[0:4]) != "RIFF" || string(head[8:12]) != "WEBP" {
			return fmt.Errorf("这不是有效的 WebP 文件")
		}
	case ".ico":
		if len(head) < 4 || head[0] != 0x00 || head[1] != 0x00 || head[2] != 0x01 {
			return fmt.Errorf("这不是有效的 ICO 文件")
		}
	}
	return nil
}

// UploadRootPath 返回上传目录的绝对路径，供 router 托管静态文件。
func UploadRootPath(webDir string) string {
	return filepath.Join(filepath.Dir(webDir), uploadDir)
}
