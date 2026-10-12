package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ooapi/internal/db"
)

// ---------------------------------------------------------------------------
// 内存 SQL 驱动 + 媒体假表
//
// 不引入任何测试依赖：用 database/sql/driver 自己实现一个最小驱动，
// 内存里维护 media / media_refs 两张表，按 SQL 文本分派。
// 服务层因此可以完整跑通「上传 → 去重 → 引用 → 删除 → 回收」链路，
// 不需要本地 MySQL 或生产库。
// ---------------------------------------------------------------------------

type mediaRowState struct {
	id        int64
	userID    int64
	sha256    string
	size      int64
	mime      string
	kind      string
	ext       string
	origName  string
	status    int64
	refCount  int64
	width     int64
	height    int64
	createdAt time.Time
	deletedAt *time.Time
}

type mediaRefState struct {
	id      int64
	mediaID int64
	userID  int64
	refType string
	refID   string
	slot    string
	isLive  bool
}

type mediaTestDriver struct {
	mu    sync.Mutex
	seq   int64
	media map[int64]*mediaRowState
	refs  map[int64]*mediaRefState
}

func newMediaTestDriver() *mediaTestDriver {
	return &mediaTestDriver{
		media: map[int64]*mediaRowState{},
		refs:  map[int64]*mediaRefState{},
	}
}

func (d *mediaTestDriver) nextID() int64 {
	d.seq++
	return d.seq
}

func (d *mediaTestDriver) Open(string) (driver.Conn, error) { return &mediaTestConn{d}, nil }

type mediaTestConn struct{ d *mediaTestDriver }
type mediaTestRows struct {
	columns []string
	values  [][]driver.Value
}

func (c *mediaTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *mediaTestConn) Close() error              { return nil }
func (c *mediaTestConn) Begin() (driver.Tx, error) { return nil, fmt.Errorf("unexpected Begin") }

type mediaTestResult struct {
	lastID   int64
	affected int64
}

func (r mediaTestResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mediaTestResult) RowsAffected() (int64, error) { return r.affected, nil }

func (c *mediaTestConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := namedValues(args)
	qn := normalizeSQL(q)

	switch {
	case strings.Contains(qn, "INSERT INTO MEDIA (USER_ID, SHA256"):
		row := &mediaRowState{
			id:        d.nextID(),
			userID:    asInt64(vals[0]),
			sha256:    asString(vals[1]),
			size:      asInt64(vals[2]),
			mime:      asString(vals[3]),
			kind:      asString(vals[4]),
			ext:       asString(vals[5]),
			origName:  asString(vals[6]),
			width:     asInt64(vals[8]),
			height:    asInt64(vals[9]),
			status:    1,
			createdAt: time.Now(),
		}
		if err := d.checkUniqueMedia(row); err != nil {
			return nil, err
		}
		d.media[row.id] = row
		return mediaTestResult{lastID: row.id, affected: 1}, nil

	case strings.Contains(qn, "UPDATE MEDIA M LEFT JOIN"):
		// RecountRefs：占位符是两段相同的 media id 列表。
		ids := append([]int64{}, toInt64s(vals[:len(vals)/2])...)
		for _, id := range ids {
			if row, ok := d.media[id]; ok {
				var count int64
				for _, r := range d.refs {
					if r.mediaID == id && r.isLive {
						count++
					}
				}
				row.refCount = count
			}
		}
		return driver.RowsAffected(int64(len(ids))), nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = ?, DELETED_AT = NULL"):
		id := asInt64(vals[7])
		if row, ok := d.media[id]; ok {
			row.status = asInt64(vals[0])
			row.deletedAt = nil
			row.size = asInt64(vals[1])
			row.mime = asString(vals[2])
			row.kind = asString(vals[3])
			row.ext = asString(vals[4])
			row.width = asInt64(vals[5])
			row.height = asInt64(vals[6])
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "UPDATE MEDIA SET ORIG_NAME"):
		id := asInt64(vals[1])
		if row, ok := d.media[id]; ok {
			row.origName = asString(vals[0])
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = ?, DELETED_AT = ?"):
		status := asInt64(vals[0])
		deletedAt := asTimePtr(vals[1])
		cutoff := asTimePtr(vals[2])
		limit := asInt64(vals[3])
		var n int64
		for _, row := range d.media {
			if n >= limit {
				break
			}
			if row.status == 1 && row.refCount == 0 && cutoff != nil && row.createdAt.Before(*cutoff) {
				row.status = status
				row.deletedAt = deletedAt
				n++
			}
		}
		return driver.RowsAffected(n), nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = 2, DELETED_AT = NOW() WHERE ID = ?"):
		// 测试直接调用的软删（模拟已删除行）。
		if row, ok := d.media[asInt64(vals[0])]; ok {
			row.status = 2
			now := time.Now()
			row.deletedAt = &now
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "UPDATE MEDIA SET LAST_ACCESS_AT"):
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = ?, DELETED_AT = NOW()"):
		if row, ok := d.media[asInt64(vals[1])]; ok {
			now := time.Now()
			row.status = asInt64(vals[0])
			row.deletedAt = &now
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "INSERT INTO MEDIA_REFS"):
		mediaID, userID := asInt64(vals[0]), asInt64(vals[1])
		refType, refID, slot := asString(vals[2]), asString(vals[3]), asString(vals[4])
		for _, r := range d.refs {
			if r.mediaID == mediaID && r.refType == refType && r.refID == refID && r.slot == slot {
				r.isLive = true
				return driver.RowsAffected(1), nil
			}
		}
		d.refs[d.nextID()] = &mediaRefState{
			mediaID: mediaID, userID: userID, refType: refType, refID: refID, slot: slot, isLive: true,
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "UPDATE MEDIA_REFS SET IS_LIVE = 0") && strings.Contains(qn, "REF_TYPE = ? AND REF_ID IN"):
		refType := asString(vals[0])
		ids := map[string]bool{}
		for _, v := range vals[1:] {
			ids[asString(v)] = true
		}
		var n int64
		for _, r := range d.refs {
			if r.isLive && r.refType == refType && ids[r.refID] {
				r.isLive = false
				n++
			}
		}
		return driver.RowsAffected(n), nil

	case strings.Contains(qn, "UPDATE MEDIA_REFS SET IS_LIVE = 0") && strings.Contains(qn, "WHERE MEDIA_ID = ?"):
		mediaID := asInt64(vals[0])
		var n int64
		for _, r := range d.refs {
			if r.isLive && r.mediaID == mediaID {
				r.isLive = false
				n++
			}
		}
		return driver.RowsAffected(n), nil

	case strings.Contains(qn, "DELETE FROM MEDIA_REFS WHERE MEDIA_ID = ?"):
		mediaID := asInt64(vals[0])
		for id, r := range d.refs {
			if r.mediaID == mediaID {
				delete(d.refs, id)
			}
		}
		return driver.RowsAffected(1), nil

	case strings.Contains(qn, "DELETE FROM MEDIA WHERE ID = ?"):
		delete(d.media, asInt64(vals[0]))
		return driver.RowsAffected(1), nil

	default:
		return driver.RowsAffected(1), nil
	}
}

func (c *mediaTestConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := namedValues(args)
	qn := normalizeSQL(q)

	switch {
	case strings.Contains(qn, "SELECT ID, STATUS FROM MEDIA WHERE USER_ID = ? AND SHA256 = ? LIMIT 1"):
		uid, sha := asInt64(vals[0]), asString(vals[1])
		for _, row := range d.media {
			if row.userID == uid && row.sha256 == sha {
				return &mediaTestRows{[]string{"id", "status"}, [][]driver.Value{{row.id, row.status}}}, nil
			}
		}
		return &mediaTestRows{columns: []string{"id", "status"}}, nil

	case strings.Contains(qn, "SELECT ID FROM MEDIA WHERE USER_ID = ? AND SHA256 = ? LIMIT 1"):
		uid, sha := asInt64(vals[0]), asString(vals[1])
		for _, row := range d.media {
			if row.userID == uid && row.sha256 == sha {
				return &mediaTestRows{[]string{"id"}, [][]driver.Value{{row.id}}}, nil
			}
		}
		return &mediaTestRows{columns: []string{"id"}}, nil

	case strings.Contains(qn, "SELECT COALESCE(SUM(SIZE),0) FROM MEDIA"):
		var total int64
		for _, row := range d.media {
			if row.userID == asInt64(vals[0]) && row.status != 2 {
				total += row.size
			}
		}
		return &mediaTestRows{[]string{"n"}, [][]driver.Value{{total}}}, nil

	case strings.Contains(qn, "SELECT COUNT(*), COALESCE(SUM(SIZE),0) FROM MEDIA WHERE"):
		var count, bytes int64
		for _, row := range d.media {
			if row.userID == asInt64(vals[0]) && row.status != 2 {
				count++
				bytes += row.size
			}
		}
		return &mediaTestRows{[]string{"c", "b"}, [][]driver.Value{{count, bytes}}}, nil

	case strings.Contains(qn, "SELECT KIND, COUNT(*)"):
		type agg struct{ count, bytes int64 }
		byKind := map[string]agg{}
		for _, row := range d.media {
			if row.userID != asInt64(vals[0]) || row.status == 2 {
				continue
			}
			v := byKind[row.kind]
			v.count++
			v.bytes += row.size
			byKind[row.kind] = v
		}
		out := [][]driver.Value{}
		for kind, v := range byKind {
			out = append(out, []driver.Value{kind, v.count, v.bytes})
		}
		return &mediaTestRows{[]string{"kind", "c", "b"}, out}, nil

	case strings.Contains(qn, "SELECT DISTINCT MEDIA_ID FROM MEDIA_REFS"):
		refType := asString(vals[0])
		ids := map[string]bool{}
		for _, v := range vals[1:] {
			ids[asString(v)] = true
		}
		seen := map[int64]bool{}
		out := [][]driver.Value{}
		for _, r := range d.refs {
			if r.isLive && r.refType == refType && ids[r.refID] && !seen[r.mediaID] {
				seen[r.mediaID] = true
				out = append(out, []driver.Value{r.mediaID})
			}
		}
		return &mediaTestRows{[]string{"media_id"}, out}, nil

	case strings.Contains(qn, "SELECT REF_TYPE, REF_ID FROM MEDIA_REFS WHERE MEDIA_ID = ?"):
		mediaID := asInt64(vals[0])
		out := [][]driver.Value{}
		for _, r := range d.refs {
			if r.isLive && r.mediaID == mediaID {
				out = append(out, []driver.Value{r.refType, r.refID})
			}
		}
		return &mediaTestRows{[]string{"ref_type", "ref_id"}, out}, nil

	case strings.Contains(qn, "SELECT ID, SHA256, EXT FROM MEDIA WHERE STATUS = ?"):
		status := asInt64(vals[0])
		cutoff := asTimePtr(vals[1])
		out := [][]driver.Value{}
		for _, row := range d.media {
			if row.status == status && row.deletedAt != nil && cutoff != nil && row.deletedAt.Before(*cutoff) {
				out = append(out, []driver.Value{row.id, row.sha256, row.ext})
			}
		}
		return &mediaTestRows{[]string{"id", "sha256", "ext"}, out}, nil

	case strings.Contains(qn, "SELECT COUNT(*) FROM MEDIA WHERE SHA256 = ? AND STATUS <> ? AND ID <> ?"):
		sha := asString(vals[0])
		var n int64
		for _, row := range d.media {
			if row.sha256 == sha && row.status != 2 && row.id != asInt64(vals[2]) {
				n++
			}
		}
		return &mediaTestRows{[]string{"n"}, [][]driver.Value{{n}}}, nil

	case strings.Contains(qn, "FROM MEDIA WHERE ID = ? LIMIT 1"):
		id := asInt64(vals[0])
		row, ok := d.media[id]
		if !ok {
			return &mediaTestRows{columns: mediaColumns()}, nil
		}
		return &mediaTestRows{mediaColumns(), [][]driver.Value{mediaValues(row)}}, nil

	default:
		return &mediaTestRows{columns: []string{"value"}}, nil
	}
}

func mediaColumns() []string {
	return []string{"id", "user_id", "sha256", "size", "mime", "kind", "ext", "orig_name",
		"source", "width", "height", "ref_count", "status", "deleted_at", "last_access_at", "created_at"}
}

func mediaValues(r *mediaRowState) []driver.Value {
	var deleted any
	if r.deletedAt != nil {
		deleted = *r.deletedAt
	}
	return []driver.Value{r.id, r.userID, r.sha256, r.size, r.mime, r.kind, r.ext, r.origName,
		"upload", r.width, r.height, r.refCount, r.status, deleted, nil, r.createdAt}
}

func (r *mediaTestRows) Columns() []string { return r.columns }
func (r *mediaTestRows) Close() error      { return nil }
func (r *mediaTestRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

// checkUniqueMedia 模拟 uk_media_owner_sha 唯一键。
func (d *mediaTestDriver) checkUniqueMedia(row *mediaRowState) error {
	for _, other := range d.media {
		if other.userID == row.userID && other.sha256 == row.sha256 {
			return fmt.Errorf("Error 1062: Duplicate entry '%d-%s' for key 'uk_media_owner_sha'", row.userID, row.sha256)
		}
	}
	return nil
}

func normalizeSQL(q string) string {
	return strings.Join(strings.Fields(strings.ToUpper(q)), " ")
}

func namedValues(args []driver.NamedValue) []any {
	out := make([]any, len(args))
	for i, a := range args {
		out[i] = a.Value
	}
	return out
}

func asInt64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case uint64:
		return int64(n)
	case float64:
		return int64(n)
	case []byte:
		var out int64
		fmt.Sscanf(string(n), "%d", &out)
		return out
	case string:
		var out int64
		fmt.Sscanf(n, "%d", &out)
		return out
	}
	return 0
}

func asString(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	}
	return ""
}

func asTimePtr(v any) *time.Time {
	switch t := v.(type) {
	case time.Time:
		return &t
	}
	return nil
}

func toInt64s(vals []any) []int64 {
	out := make([]int64, 0, len(vals))
	for _, v := range vals {
		out = append(out, asInt64(v))
	}
	return out
}

var mediaDriverSequence atomic.Uint64

// useMediaTestDB 安装内存驱动并返回驱动句柄（测试可直接读写假表状态）。
func useMediaTestDB(t *testing.T) *mediaTestDriver {
	t.Helper()
	d := newMediaTestDriver()
	name := fmt.Sprintf("media-service-test-%d", mediaDriverSequence.Add(1))
	sql.Register(name, d)
	conn, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	original := db.DB
	db.DB = conn
	t.Cleanup(func() {
		db.DB = original
		conn.Close()
	})
	return d
}

// mediaTestRoot 把媒体根目录指到 t.TempDir()。
func mediaTestRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	SetMediaRoot(root)
	t.Cleanup(func() { SetMediaRoot("") })
	return root
}

// ---------------------------------------------------------------------------
// 测试用最小文件构造
// ---------------------------------------------------------------------------

func pngBytes(width, height uint32) []byte {
	b := make([]byte, 33)
	copy(b, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	copy(b[8:], []byte{0, 0, 0, 13, 'I', 'H', 'D', 'R'})
	binary.BigEndian.PutUint32(b[16:], width)
	binary.BigEndian.PutUint32(b[20:], height)
	return b
}

func gifBytes(width, height uint16) []byte {
	b := make([]byte, 13)
	copy(b, []byte("GIF89a"))
	binary.LittleEndian.PutUint16(b[6:], width)
	binary.LittleEndian.PutUint16(b[8:], height)
	return b
}

// jpegBytes 构造含 SOF0 段的最小 JPEG。
// APP1 段长度 6（含长度字段自身 2 字节 + 4 字节载荷），SOF0 段紧随其后，
// 宽高是 SOF0 段里的 2 字节大端值。末尾补几个字节，保证 SOF 段不贴着文件尾
// （解析器要求 SOF 之后仍有 9 字节可读）。
func jpegBytes(width, height uint16) []byte {
	b := []byte{0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 'X', 'Y', 'Z', 'W'}
	b = append(b, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0)
	b = append(b, 0x03, 0x01, 0x22, 0x00) // 分量信息（占位）
	binary.BigEndian.PutUint16(b[15:], height)
	binary.BigEndian.PutUint16(b[17:], width)
	return b
}

func webpVP8XBytes(width, height int) []byte {
	b := make([]byte, 34)
	copy(b, []byte("RIFF"))
	binary.LittleEndian.PutUint32(b[4:], uint32(len(b)-8))
	copy(b[8:], []byte("WEBP"))
	copy(b[12:], []byte("VP8X"))
	// 24..26 与 27..29 各 3 字节小端（值 - 1）。
	b[24] = byte((width - 1) & 0xff)
	b[25] = byte((width-1)>>8) & 0xff
	b[26] = byte((width-1)>>16) & 0xff
	b[27] = byte((height - 1) & 0xff)
	b[28] = byte((height-1)>>8) & 0xff
	b[29] = byte((height-1)>>16) & 0xff
	return b
}

// ---------------------------------------------------------------------------
// 嗅探
// ---------------------------------------------------------------------------

func TestSniffMediaAcceptsWhitelist(t *testing.T) {
	cases := []struct {
		name string
		buf  []byte
		want MediaType
	}{
		{"png", pngBytes(8, 8), MediaType{Ext: "png", Mime: "image/png", Kind: MediaKindImage}},
		{"jpeg", jpegBytes(8, 8), MediaType{Ext: "jpg", Mime: "image/jpeg", Kind: MediaKindImage}},
		{"gif", gifBytes(8, 8), MediaType{Ext: "gif", Mime: "image/gif", Kind: MediaKindImage}},
		{"webp", webpVP8XBytes(8, 8), MediaType{Ext: "webp", Mime: "image/webp", Kind: MediaKindImage}},
		{"pdf", []byte("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF"), MediaType{Ext: "pdf", Mime: "application/pdf", Kind: MediaKindFile}},
		{"text", []byte("hello world\nthis is a plain text document.\n"), MediaType{Ext: "txt", Mime: "text/plain", Kind: MediaKindFile}},
		{"utf8 text", []byte("你好，世界。这是一段中文纯文本内容。\n"), MediaType{Ext: "txt", Mime: "text/plain", Kind: MediaKindFile}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := SniffMedia(tc.buf)
			if !ok || got != tc.want {
				t.Fatalf("SniffMedia(%s) = %+v ok=%v, want %+v", tc.name, got, ok, tc.want)
			}
		})
	}
}

func TestSniffMediaRejectsSvgAndBinary(t *testing.T) {
	random := make([]byte, 64)
	random[0] = 0x00
	for i := 1; i < len(random); i++ {
		random[i] = byte(i*7 + 3)
	}
	cases := []struct {
		name string
		buf  []byte
	}{
		{"svg with xml decl", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)},
		{"svg without decl", []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`)},
		{"svg uppercase", []byte(`<SVG xmlns="http://www.w3.org/2000/svg"></SVG>`)},
		{"svg deep in file", append([]byte(strings.Repeat("plain text line\n", 100)), []byte("<svg><script>x</script></svg>")...)},
		{"random binary", random},
		{"empty", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got, ok := SniffMedia(tc.buf); ok {
				t.Fatalf("expected rejection, got %+v", got)
			}
		})
	}
}

func TestSniffMediaDoesNotTrustDeclaredExtension(t *testing.T) {
	// 把可执行内容命名为 .png：嗅探只看字节，进不了白名单。
	exe := append([]byte{'M', 'Z', 0x90, 0x00}, make([]byte, 60)...)
	if _, ok := SniffMedia(exe); ok {
		t.Fatal("MZ executable passed magic sniffing")
	}
}

// ---------------------------------------------------------------------------
// 尺寸
// ---------------------------------------------------------------------------

func TestImageSizeParsing(t *testing.T) {
	if w, h := ImageSize(pngBytes(1920, 1080), "png"); w != 1920 || h != 1080 {
		t.Fatalf("png = %dx%d, want 1920x1080", w, h)
	}
	if w, h := ImageSize(gifBytes(640, 480), "gif"); w != 640 || h != 480 {
		t.Fatalf("gif = %dx%d, want 640x480", w, h)
	}
	if w, h := ImageSize(jpegBytes(40, 30), "jpg"); w != 40 || h != 30 {
		t.Fatalf("jpeg = %dx%d, want 40x30", w, h)
	}
	if w, h := ImageSize(webpVP8XBytes(300, 200), "webp"); w != 300 || h != 200 {
		t.Fatalf("webp vp8x = %dx%d, want 300x200", w, h)
	}

	// 畸形 PNG：IHDR 里是 0xFFFFFFFF，必须钳到 0 而不是写库。
	huge := pngBytes(0xffffffff, 0xffffffff)
	if w, h := ImageSize(huge, "png"); w != 0 || h != 0 {
		t.Fatalf("malformed png dims not clamped: %dx%d", w, h)
	}
	// 允许的最大像素值本身可以解析。
	if w, _ := ImageSize(pngBytes(MaxImageDim, 1), "png"); w != MaxImageDim {
		t.Fatalf("boundary dim rejected: %d", w)
	}
	if w, h := ImageSize([]byte{1, 2}, "jpg"); w != 0 || h != 0 {
		t.Fatalf("short data parsed as %dx%d", w, h)
	}
}

// ---------------------------------------------------------------------------
// 上传去重
// ---------------------------------------------------------------------------

func TestSaveBufferDedupesAndRevives(t *testing.T) {
	useMediaTestDB(t)
	mediaTestRoot(t)

	content := pngBytes(64, 32)
	first, err := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 7, OrigName: "a.png", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Deduped {
		t.Fatal("first save must not report dedupe")
	}
	if first.Width != 64 || first.Height != 32 {
		t.Fatalf("dims = %dx%d", first.Width, first.Height)
	}

	// 落盘检查：分片路径 <sha0:2>/<sha2:4>/<sha>.<ext>
	blob := MediaBlobPath(first.Sha256, first.Ext)
	if _, err := os.Stat(blob); err != nil {
		t.Fatalf("blob not written: %v", err)
	}
	if _, err := os.Stat(filepath.Join(MediaRoot(), "tmp")); err != nil {
		t.Fatalf("tmp dir missing: %v", err)
	}

	second, err := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 7, OrigName: "b.png", Source: "chat"})
	if err != nil {
		t.Fatal(err)
	}
	if !second.Deduped || second.ID != first.ID {
		t.Fatalf("dedupe failed: %+v", second)
	}

	// 软删后再次上传 → 复活同一行，而不是插入新行（否则唯一键冲突）。
	if _, err := db.DB.Exec("UPDATE media SET status = 2, deleted_at = NOW() WHERE id = ?", first.ID); err != nil {
		t.Fatal(err)
	}
	third, err := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 7, OrigName: "c.png", Source: "post"})
	if err != nil {
		t.Fatal(err)
	}
	if !third.Deduped || third.ID != first.ID {
		t.Fatalf("revive failed: %+v", third)
	}
	row, err := GetMedia(first.ID)
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != MediaStatusNormal || row.DeletedAt != nil {
		t.Fatalf("revived row still deleted: %+v", row)
	}
}

func TestSaveBufferValidatesTypeAndSize(t *testing.T) {
	useMediaTestDB(t)
	mediaTestRoot(t)

	if _, err := SaveBuffer(SaveMediaInput{Buffer: nil, UserID: 1}); MediaErrorCode(err) != MediaCodeEmpty {
		t.Fatalf("empty content error = %v", err)
	}
	if _, err := SaveBuffer(SaveMediaInput{Buffer: []byte("<svg></svg>"), UserID: 1}); MediaErrorCode(err) != MediaCodeType {
		t.Fatalf("svg error = %v", err)
	}
	if _, err := SaveBuffer(SaveMediaInput{Buffer: []byte{0, 1, 2, 3, 4, 5, 6, 7}}); MediaErrorCode(err) != MediaCodeType {
		t.Fatalf("binary error = %v", err)
	}
}

func TestUsedBytesIgnoresSoftDeleted(t *testing.T) {
	d := useMediaTestDB(t)
	mediaTestRoot(t)

	content := gifBytes(4, 4)
	saved, err := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 11})
	if err != nil {
		t.Fatal(err)
	}
	used, err := UsedBytes(11)
	if err != nil {
		t.Fatal(err)
	}
	if used != int64(len(content)) {
		t.Fatalf("used = %d, want %d", used, len(content))
	}

	// 软删行不再占配额。
	d.media[saved.ID].status = MediaStatusDeleted
	used, err = UsedBytes(11)
	if err != nil {
		t.Fatal(err)
	}
	if used != 0 {
		t.Fatalf("soft-deleted media still counted: %d", used)
	}

	// 统计接口也按同一口径（status != 2）。
	st, err := UserStats(11)
	if err != nil {
		t.Fatal(err)
	}
	if st.Count != 0 || st.Bytes != 0 || len(st.ByKind) != 0 {
		t.Fatalf("stats include soft-deleted rows: %+v", st)
	}
}

// ---------------------------------------------------------------------------
// 引用计数
// ---------------------------------------------------------------------------

func TestRefCountingAttachReleaseRecount(t *testing.T) {
	useMediaTestDB(t)
	mediaTestRoot(t)

	saved, err := SaveBuffer(SaveMediaInput{Buffer: pngBytes(4, 4), UserID: 3})
	if err != nil {
		t.Fatal(err)
	}
	if err := AttachRef(saved.ID, "msg", "101", "1", 3); err != nil {
		t.Fatal(err)
	}
	row, _ := GetMedia(saved.ID)
	if row.RefCount != 1 {
		t.Fatalf("ref_count = %d, want 1", row.RefCount)
	}

	// 同一对象同一位置重复绑定幂等，不重复计数。
	if err := AttachRef(saved.ID, "msg", "101", "1", 3); err != nil {
		t.Fatal(err)
	}
	row, _ = GetMedia(saved.ID)
	if row.RefCount != 1 {
		t.Fatalf("idempotent attach changed ref_count to %d", row.RefCount)
	}

	if err := AttachRef(saved.ID, "msg", "101", "2", 3); err != nil {
		t.Fatal(err)
	}
	row, _ = GetMedia(saved.ID)
	if row.RefCount != 2 {
		t.Fatalf("second slot ref_count = %d, want 2", row.RefCount)
	}

	if _, err := ReleaseRefs("msg", []string{"101"}); err != nil {
		t.Fatal(err)
	}
	row, _ = GetMedia(saved.ID)
	if row.RefCount != 0 {
		t.Fatalf("after release ref_count = %d, want 0", row.RefCount)
	}
	refs, err := LiveRefs(saved.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 0 {
		t.Fatalf("live refs after release = %+v", refs)
	}
}

func TestLiveRefsListsBlockingReferences(t *testing.T) {
	useMediaTestDB(t)
	mediaTestRoot(t)

	saved, _ := SaveBuffer(SaveMediaInput{Buffer: gifBytes(2, 2), UserID: 9})
	_ = AttachRef(saved.ID, "post", "77", "cover", 9)
	_ = AttachRef(saved.ID, "chat", "88", "", 9)

	refs, err := LiveRefs(saved.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 {
		t.Fatalf("refs = %+v, want 2", refs)
	}
	found := map[string]bool{}
	for _, r := range refs {
		found[r.RefType+"/"+r.RefID] = true
	}
	if !found["post/77"] || !found["chat/88"] {
		t.Fatalf("missing refs: %+v", refs)
	}
}

func TestReleaseMediaRefsForceUnbind(t *testing.T) {
	useMediaTestDB(t)
	mediaTestRoot(t)

	saved, _ := SaveBuffer(SaveMediaInput{Buffer: gifBytes(2, 2), UserID: 4})
	_ = AttachRef(saved.ID, "avatar", "4", "avatar", 4)
	_ = AttachRef(saved.ID, "post", "5", "cover", 4)

	if _, err := ReleaseMediaRefs(saved.ID); err != nil {
		t.Fatal(err)
	}
	row, _ := GetMedia(saved.ID)
	if row.RefCount != 0 {
		t.Fatalf("force release left ref_count = %d", row.RefCount)
	}
}

// ---------------------------------------------------------------------------
// 回收
// ---------------------------------------------------------------------------

func TestRunGCSoftDeletesOrphansThenPurges(t *testing.T) {
	d := useMediaTestDB(t)
	mediaTestRoot(t)

	referenced, _ := SaveBuffer(SaveMediaInput{Buffer: pngBytes(3, 3), UserID: 1})
	orphan, _ := SaveBuffer(SaveMediaInput{Buffer: pngBytes(5, 5), UserID: 1})
	_ = AttachRef(referenced.ID, "msg", "1", "", 1)
	// 把它推到孤儿时限之外（默认 24h）。
	d.media[orphan.ID].createdAt = time.Now().Add(-48 * time.Hour)

	res, err := RunGC(100)
	if err != nil {
		t.Fatal(err)
	}
	if res.SoftDeleted != 1 {
		t.Fatalf("soft_deleted = %d, want 1", res.SoftDeleted)
	}
	if got, _ := GetMedia(orphan.ID); got.Status != MediaStatusDeleted {
		t.Fatalf("orphan status = %d, want deleted", got.Status)
	}
	if got, _ := GetMedia(referenced.ID); got.Status != MediaStatusNormal {
		t.Fatal("referenced media was soft deleted")
	}

	// 软删时间调到保留期之外（默认 7 天）：文件与行都应物理清理。
	d.media[orphan.ID].deletedAt = timePtr(time.Now().Add(-30 * 24 * time.Hour))
	blob := MediaBlobPath(orphan.Sha256, orphan.Ext)
	if _, err := os.Stat(blob); err != nil {
		t.Fatalf("blob missing before purge: %v", err)
	}
	res, err = RunGC(100)
	if err != nil {
		t.Fatal(err)
	}
	if res.Purged != 1 {
		t.Fatalf("purged = %d, want 1", res.Purged)
	}
	if _, err := os.Stat(blob); !os.IsNotExist(err) {
		t.Fatal("blob still on disk after purge")
	}
	if _, err := GetMedia(orphan.ID); err == nil {
		t.Fatal("media row survived purge")
	}
	if _, err := os.Stat(MediaBlobPath(referenced.Sha256, referenced.Ext)); err != nil {
		t.Fatalf("live blob was deleted: %v", err)
	}
}

func TestRunGCKeepsSharedBlob(t *testing.T) {
	d := useMediaTestDB(t)
	mediaTestRoot(t)

	// 同一内容归两个用户：物理文件只有一份，删任意一行都不能动文件。
	content := pngBytes(11, 22)
	a, _ := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 1})
	b, _ := SaveBuffer(SaveMediaInput{Buffer: content, UserID: 2})
	if a.Sha256 != b.Sha256 {
		t.Fatal("same content produced different hashes")
	}

	d.media[a.ID].status = MediaStatusDeleted
	d.media[a.ID].deletedAt = timePtr(time.Now().Add(-30 * 24 * time.Hour))
	blob := MediaBlobPath(a.Sha256, a.Ext)
	if _, err := RunGC(100); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(blob); err != nil {
		t.Fatalf("shared blob was deleted: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

func TestMediaSignRoundTrip(t *testing.T) {
	SetJWTSecret("media-sign-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	sig := SignMedia(42)
	if !VerifyMediaSign(42, sig) {
		t.Fatal("valid signature rejected")
	}
	if VerifyMediaSign(43, sig) {
		t.Fatal("signature accepted for a different id")
	}
	if VerifyMediaSign(42, sig+"x") {
		t.Fatal("tampered signature accepted")
	}
	if VerifyMediaSign(42, "") || VerifyMediaSign(42, "no-dot") {
		t.Fatal("malformed signature accepted")
	}
	// 过期签名必须判否。
	expired := SignMediaTTL(42, -time.Minute)
	if VerifyMediaSign(42, expired) {
		t.Fatal("expired signature accepted")
	}
	// 密钥不同 → 签名不可跨实例复用。
	SetJWTSecret("another-secret")
	if VerifyMediaSign(42, sig) {
		t.Fatal("signature accepted under a different secret")
	}
}

func TestMediaURLCarriesSignature(t *testing.T) {
	SetJWTSecret("media-url-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	u := MediaURL(9)
	if !strings.HasPrefix(u, "/api/media/9/raw?s=") {
		t.Fatalf("unexpected url: %s", u)
	}
	dot := strings.Index(u, "s=")
	if dot < 0 || !VerifyMediaSign(9, u[dot+2:]) {
		t.Fatalf("url signature does not verify: %s", u)
	}
	if MediaURL(0) != "" {
		t.Fatal("zero id should produce empty url")
	}
}

// ---------------------------------------------------------------------------
// 设置与文案
// ---------------------------------------------------------------------------

func TestNormalizeMediaSource(t *testing.T) {
	for _, ok := range []string{"upload", "avatar", "post", "chat", "community", "admin", " CHAT ", "Avatar"} {
		if got := NormalizeMediaSource(ok); got != strings.ToLower(strings.TrimSpace(ok)) {
			t.Fatalf("source %q normalized to %q", ok, got)
		}
	}
	for _, bad := range []string{"", "unknown", "<script>", "upload;drop"} {
		if got := NormalizeMediaSource(bad); got != "upload" {
			t.Fatalf("source %q should fall back to upload, got %q", bad, got)
		}
	}
}

func TestMediaErrorCodesAndMessages(t *testing.T) {
	err := mediaError(MediaCodeTooLarge, "文件过大：%.1fMB，上限 %dMB", 12.5, 10)
	if MediaErrorCode(err) != MediaCodeTooLarge {
		t.Fatal("code lost")
	}
	if !strings.Contains(err.Error(), "12.5") || !strings.Contains(err.Error(), "10MB") {
		t.Fatalf("message = %q", err.Error())
	}
	if MediaErrorCode(fmt.Errorf("plain")) != "" {
		t.Fatal("plain error should have no media code")
	}
	if MediaErrorMessage(fmt.Errorf("plain")) == "" {
		t.Fatal("fallback message missing")
	}
}

func timePtr(t time.Time) *time.Time { return &t }
