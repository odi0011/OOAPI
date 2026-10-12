package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"ooapi/internal/authz"
	"ooapi/internal/db"
	"ooapi/internal/middleware"
	"ooapi/internal/models"
	"ooapi/internal/services"
)

/*
媒体 handler 测试。

用与 caller_clients_test.go 同套路的内存 SQL 驱动（mediaHandlerTestDriver），
配合 services.SetMediaRoot(t.TempDir())，不需要 MySQL 与网络。
所有断言都打在 handler 的响应上 —— 驱动只当假数据库用。
*/

// ---------------------------------------------------------------------------
// 内存驱动：media / media_refs / users 三张小表
// ---------------------------------------------------------------------------

type mediaHandlerRow struct {
	id       int64
	userID   int64
	sha256   string
	size     int64
	mime     string
	kind     string
	ext      string
	origName string
	source   string
	width    int64
	height   int64
	refCount int64
	status   int64
	created  time.Time
	deleted  *time.Time
}

type mediaHandlerRef struct {
	mediaID int64
	userID  int64
	refType string
	refID   string
	slot    string
	live    bool
}

type mediaHandlerUser struct {
	username, displayName, email string
	bio, website, location       string
	avatarURL                    string
	avatarMediaID                int64
	groupName                    string
	quota, usedQuota             int64
}

// mediaHandlerBinding 是三方绑定记录的投影：这里只用到头像字段
// （移除自定义头像时要回退到平台头像）。
type mediaHandlerBinding struct {
	userID int64
	avatar string
}

type mediaHandlerTestDriver struct {
	mu       sync.Mutex
	seq      int64
	rows     map[int64]*mediaHandlerRow
	refs     []*mediaHandlerRef
	users    map[int64]*mediaHandlerUser
	bindings []mediaHandlerBinding
}

func newMediaHandlerDriver() *mediaHandlerTestDriver {
	return &mediaHandlerTestDriver{
		rows:  map[int64]*mediaHandlerRow{},
		users: map[int64]*mediaHandlerUser{},
	}
}

func (d *mediaHandlerTestDriver) nextID() int64 { d.seq++; return d.seq }

type mediaHandlerTestConn struct{ d *mediaHandlerTestDriver }

type mediaHandlerResult struct{ lastID, affected int64 }

func (r mediaHandlerResult) LastInsertId() (int64, error) { return r.lastID, nil }
func (r mediaHandlerResult) RowsAffected() (int64, error) { return r.affected, nil }

func (d *mediaHandlerTestDriver) Open(string) (driver.Conn, error) {
	return &mediaHandlerTestConn{d}, nil
}

func (c *mediaHandlerTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *mediaHandlerTestConn) Close() error              { return nil }
func (c *mediaHandlerTestConn) Begin() (driver.Tx, error) { return nil, fmt.Errorf("unexpected Begin") }

type mediaHandlerRows struct {
	columns []string
	values  [][]driver.Value
}

func (r *mediaHandlerRows) Columns() []string { return r.columns }
func (r *mediaHandlerRows) Close() error      { return nil }
func (r *mediaHandlerRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

func normalizeHandlerSQL(q string) string {
	return strings.Join(strings.Fields(strings.ToUpper(q)), " ")
}

func handlerArgs(args []driver.NamedValue) []any {
	out := make([]any, len(args))
	for i, a := range args {
		out[i] = a.Value
	}
	return out
}

func handlerInt(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case float64:
		return int64(n)
	case string:
		var out int64
		fmt.Sscanf(n, "%d", &out)
		return out
	case []byte:
		var out int64
		fmt.Sscanf(string(n), "%d", &out)
		return out
	}
	return 0
}

func handlerStr(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case []byte:
		return string(s)
	}
	return ""
}

func handlerTime(v any) *time.Time {
	if t, ok := v.(time.Time); ok {
		return &t
	}
	return nil
}

// matchMediaFilter 按 SQL 里出现的条件顺序消费参数，判断行是否命中。
// 条件出现顺序与 handler 拼接顺序一致：user_id → kind → orig_name LIKE → status。
func matchMediaFilter(qn string, args []any, row *mediaHandlerRow) bool {
	type cond struct {
		idx int
		key string
	}
	var conds []cond
	if i := strings.Index(qn, "USER_ID = ?"); i >= 0 {
		conds = append(conds, cond{i, "user"})
	}
	if i := strings.Index(qn, "KIND = ?"); i >= 0 {
		conds = append(conds, cond{i, "kind"})
	}
	if i := strings.Index(qn, "ORIG_NAME LIKE ?"); i >= 0 {
		conds = append(conds, cond{i, "q"})
	}
	if i := strings.Index(qn, "STATUS = ?"); i >= 0 {
		conds = append(conds, cond{i, "status"})
	}
	sort.Slice(conds, func(a, b int) bool { return conds[a].idx < conds[b].idx })

	ai := 0
	for _, c := range conds {
		if ai >= len(args) {
			break
		}
		v := args[ai]
		ai++
		switch c.key {
		case "user":
			if row.userID != handlerInt(v) {
				return false
			}
		case "kind":
			if row.kind != handlerStr(v) {
				return false
			}
		case "q":
			pat := strings.Trim(handlerStr(v), "%")
			if !strings.Contains(strings.ToLower(row.origName), strings.ToLower(pat)) {
				return false
			}
		case "status":
			if row.status != handlerInt(v) {
				return false
			}
		}
	}
	return true
}

func (c *mediaHandlerTestConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := handlerArgs(args)
	qn := normalizeHandlerSQL(q)

	switch {
	case strings.Contains(qn, "INSERT INTO MEDIA (USER_ID, SHA256"):
		row := &mediaHandlerRow{
			id:       d.nextID(),
			userID:   handlerInt(vals[0]),
			sha256:   handlerStr(vals[1]),
			size:     handlerInt(vals[2]),
			mime:     handlerStr(vals[3]),
			kind:     handlerStr(vals[4]),
			ext:      handlerStr(vals[5]),
			origName: handlerStr(vals[6]),
			source:   handlerStr(vals[7]),
			width:    handlerInt(vals[8]),
			height:   handlerInt(vals[9]),
			status:   1,
			created:  time.Now(),
		}
		for _, other := range d.rows {
			if other.userID == row.userID && other.sha256 == row.sha256 {
				return nil, fmt.Errorf("Error 1062: Duplicate entry for key 'uk_media_owner_sha'")
			}
		}
		d.rows[row.id] = row
		return mediaHandlerResult{row.id, 1}, nil

	case strings.Contains(qn, "UPDATE MEDIA M LEFT JOIN"):
		ids := handlerArgs(args)
		for _, v := range ids[:len(ids)/2] {
			id := handlerInt(v)
			if row, ok := d.rows[id]; ok {
				var count int64
				for _, r := range d.refs {
					if r.mediaID == id && r.live {
						count++
					}
				}
				row.refCount = count
			}
		}
		return mediaHandlerResult{0, int64(len(ids) / 2)}, nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = ?, DELETED_AT = NULL"),
		strings.Contains(qn, "UPDATE MEDIA SET ORIG_NAME = ?"):
		if strings.Contains(qn, "ORIG_NAME") {
			if row, ok := d.rows[handlerInt(vals[1])]; ok {
				row.origName = handlerStr(vals[0])
			}
		} else if row, ok := d.rows[handlerInt(vals[7])]; ok {
			row.status = handlerInt(vals[0])
			row.deleted = nil
			row.size = handlerInt(vals[1])
			row.mime = handlerStr(vals[2])
			row.kind = handlerStr(vals[3])
			row.ext = handlerStr(vals[4])
			row.width = handlerInt(vals[5])
			row.height = handlerInt(vals[6])
		}
		return mediaHandlerResult{0, 1}, nil

	case strings.Contains(qn, "UPDATE MEDIA SET STATUS = ?, DELETED_AT = NOW()"):
		if row, ok := d.rows[handlerInt(vals[1])]; ok {
			now := time.Now()
			row.status = handlerInt(vals[0])
			row.deleted = &now
		}
		return mediaHandlerResult{0, 1}, nil

	case strings.Contains(qn, "INSERT INTO MEDIA_REFS"):
		mediaID, userID := handlerInt(vals[0]), handlerInt(vals[1])
		refType, refID, slot := handlerStr(vals[2]), handlerStr(vals[3]), handlerStr(vals[4])
		for _, r := range d.refs {
			if r.mediaID == mediaID && r.refType == refType && r.refID == refID && r.slot == slot {
				r.live = true
				r.userID = userID
				return mediaHandlerResult{0, 1}, nil
			}
		}
		d.refs = append(d.refs, &mediaHandlerRef{mediaID: mediaID, userID: userID, refType: refType, refID: refID, slot: slot, live: true})
		return mediaHandlerResult{0, 1}, nil

	case strings.Contains(qn, "UPDATE MEDIA_REFS SET IS_LIVE = 0") && strings.Contains(qn, "REF_TYPE = ? AND REF_ID IN"):
		refType := handlerStr(vals[0])
		ids := map[string]bool{}
		for _, v := range vals[1:] {
			ids[handlerStr(v)] = true
		}
		var n int64
		for _, r := range d.refs {
			if r.live && r.refType == refType && ids[r.refID] {
				r.live = false
				n++
			}
		}
		return mediaHandlerResult{0, n}, nil

	case strings.Contains(qn, "UPDATE MEDIA_REFS SET IS_LIVE = 0") && strings.Contains(qn, "WHERE MEDIA_ID = ?"):
		mediaID := handlerInt(vals[0])
		var n int64
		for _, r := range d.refs {
			if r.live && r.mediaID == mediaID {
				r.live = false
				n++
			}
		}
		return mediaHandlerResult{0, n}, nil

	case strings.Contains(qn, "UPDATE USERS SET AVATAR_MEDIA_ID = ?, AVATAR_URL = ?"):
		if u, ok := d.users[handlerInt(vals[2])]; ok {
			u.avatarMediaID = handlerInt(vals[0])
			u.avatarURL = handlerStr(vals[1])
		}
		return mediaHandlerResult{0, 1}, nil

	case strings.Contains(qn, "UPDATE USERS SET AVATAR_MEDIA_ID = 0, AVATAR_URL = ?"):
		if u, ok := d.users[handlerInt(vals[1])]; ok {
			u.avatarMediaID = 0
			u.avatarURL = handlerStr(vals[0])
		}
		return mediaHandlerResult{0, 1}, nil

	case strings.Contains(qn, "UPDATE USERS SET DISPLAY_NAME = ?, EMAIL = ?, BIO = ?, WEBSITE = ?, LOCATION = ?"):
		if u, ok := d.users[handlerInt(vals[5])]; ok {
			u.displayName = handlerStr(vals[0])
			u.email = handlerStr(vals[1])
			u.bio = handlerStr(vals[2])
			u.website = handlerStr(vals[3])
			u.location = handlerStr(vals[4])
		}
		return mediaHandlerResult{0, 1}, nil

	default:
		return mediaHandlerResult{0, 1}, nil
	}
}

func (c *mediaHandlerTestConn) QueryContext(_ context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	vals := handlerArgs(args)
	qn := normalizeHandlerSQL(q)

	switch {
	case strings.Contains(qn, "SELECT AVATAR_URL FROM USER_OAUTH WHERE USER_ID = ?"):
		for _, b := range d.bindings {
			if b.userID == handlerInt(vals[0]) && b.avatar != "" {
				return &mediaHandlerRows{[]string{"avatar_url"}, [][]driver.Value{{b.avatar}}}, nil
			}
		}
		return &mediaHandlerRows{columns: []string{"avatar_url"}}, nil

	case strings.Contains(qn, "SELECT ID, STATUS FROM MEDIA WHERE USER_ID = ? AND SHA256 = ? LIMIT 1"):
		for _, row := range d.rows {
			if row.userID == handlerInt(vals[0]) && row.sha256 == handlerStr(vals[1]) {
				return &mediaHandlerRows{[]string{"id", "status"}, [][]driver.Value{{row.id, row.status}}}, nil
			}
		}
		return &mediaHandlerRows{columns: []string{"id", "status"}}, nil

	case strings.Contains(qn, "SELECT ID FROM MEDIA WHERE USER_ID = ? AND SHA256 = ? LIMIT 1"):
		for _, row := range d.rows {
			if row.userID == handlerInt(vals[0]) && row.sha256 == handlerStr(vals[1]) {
				return &mediaHandlerRows{[]string{"id"}, [][]driver.Value{{row.id}}}, nil
			}
		}
		return &mediaHandlerRows{columns: []string{"id"}}, nil

	case strings.Contains(qn, "SELECT COALESCE(SUM(SIZE),0) FROM MEDIA WHERE USER_ID = ? AND STATUS <> ?"):
		var total int64
		for _, row := range d.rows {
			if row.userID == handlerInt(vals[0]) && row.status != 2 {
				total += row.size
			}
		}
		return &mediaHandlerRows{[]string{"n"}, [][]driver.Value{{total}}}, nil

	case strings.Contains(qn, "SELECT COUNT(*), COALESCE(SUM(SIZE),0) FROM MEDIA WHERE"):
		scoped := strings.Contains(qn, "USER_ID = ?")
		var count, size int64
		for _, row := range d.rows {
			if row.status == 2 {
				continue
			}
			if scoped && row.userID != handlerInt(vals[0]) {
				continue
			}
			count++
			size += row.size
		}
		return &mediaHandlerRows{[]string{"c", "s"}, [][]driver.Value{{count, size}}}, nil

	case strings.Contains(qn, "SELECT KIND, COUNT(*), COALESCE(SUM(SIZE),0) FROM MEDIA"):
		type agg struct{ count, size int64 }
		scoped := strings.Contains(qn, "USER_ID = ?")
		byKind := map[string]agg{}
		for _, row := range d.rows {
			if row.status == 2 {
				continue
			}
			if scoped && row.userID != handlerInt(vals[0]) {
				continue
			}
			v := byKind[row.kind]
			v.count++
			v.size += row.size
			byKind[row.kind] = v
		}
		out := [][]driver.Value{}
		for kind, v := range byKind {
			out = append(out, []driver.Value{kind, v.count, v.size})
		}
		return &mediaHandlerRows{[]string{"kind", "c", "b"}, out}, nil

	case strings.Contains(qn, "FROM MEDIA WHERE ID = ? LIMIT 1"):
		id := handlerInt(vals[0])
		row, ok := d.rows[id]
		if !ok {
			return &mediaHandlerRows{columns: handlerMediaColumns()}, nil
		}
		return &mediaHandlerRows{handlerMediaColumns(), [][]driver.Value{handlerMediaValues(row)}}, nil

	case strings.Contains(qn, "SELECT ID, USER_ID, SIZE, MIME, KIND, EXT, ORIG_NAME, SOURCE, WIDTH, HEIGHT, REF_COUNT, STATUS, CREATED_AT FROM MEDIA"):
		limit := handlerInt(vals[len(vals)-2])
		offset := handlerInt(vals[len(vals)-1])
		matched := []*mediaHandlerRow{}
		for _, row := range d.rows {
			if matchMediaFilter(qn, vals, row) {
				matched = append(matched, row)
			}
		}
		sort.Slice(matched, func(a, b int) bool { return matched[a].id > matched[b].id })
		out := [][]driver.Value{}
		for i, row := range matched {
			if int64(i) < offset {
				continue
			}
			if int64(len(out)) >= limit {
				break
			}
			out = append(out, []driver.Value{
				row.id, row.userID, row.size, row.mime, row.kind, row.ext, row.origName,
				row.source, row.width, row.height, row.refCount, row.status, row.created,
			})
		}
		return &mediaHandlerRows{[]string{"id", "user_id", "size", "mime", "kind", "ext", "orig_name",
			"source", "width", "height", "ref_count", "status", "created_at"}, out}, nil

	case strings.Contains(qn, "SELECT COUNT(*) FROM MEDIA WHERE"):
		var n int64
		for _, row := range d.rows {
			if matchMediaFilter(qn, vals, row) {
				n++
			}
		}
		return &mediaHandlerRows{[]string{"n"}, [][]driver.Value{{n}}}, nil

	case strings.Contains(qn, "SELECT REF_TYPE, REF_ID FROM MEDIA_REFS WHERE MEDIA_ID = ? AND IS_LIVE = 1"):
		limit := handlerInt(vals[1])
		mediaID := handlerInt(vals[0])
		out := [][]driver.Value{}
		for _, r := range d.refs {
			if r.live && r.mediaID == mediaID {
				out = append(out, []driver.Value{r.refType, r.refID})
				if int64(len(out)) >= limit {
					break
				}
			}
		}
		return &mediaHandlerRows{[]string{"ref_type", "ref_id"}, out}, nil

	case strings.Contains(qn, "SELECT DISTINCT MEDIA_ID FROM MEDIA_REFS"):
		refType := handlerStr(vals[0])
		ids := map[string]bool{}
		for _, v := range vals[1:] {
			ids[handlerStr(v)] = true
		}
		seen := map[int64]bool{}
		out := [][]driver.Value{}
		for _, r := range d.refs {
			if r.live && r.refType == refType && ids[r.refID] && !seen[r.mediaID] {
				seen[r.mediaID] = true
				out = append(out, []driver.Value{r.mediaID})
			}
		}
		return &mediaHandlerRows{[]string{"media_id"}, out}, nil

	case strings.Contains(qn, "SELECT AVATAR_MEDIA_ID FROM USERS WHERE ID = ?"):
		uid := handlerInt(vals[0])
		var id int64
		if u, ok := d.users[uid]; ok {
			id = u.avatarMediaID
		}
		return &mediaHandlerRows{[]string{"avatar_media_id"}, [][]driver.Value{{id}}}, nil

	case strings.Contains(qn, "SELECT USERNAME, DISPLAY_NAME, EMAIL, BIO, WEBSITE, LOCATION,"):
		uid := handlerInt(vals[0])
		u, ok := d.users[uid]
		if !ok {
			return &mediaHandlerRows{columns: []string{"username", "display_name", "email", "bio", "website",
				"location", "avatar_url", "avatar_media_id", "group_name", "quota", "used_quota"}}, nil
		}
		return &mediaHandlerRows{
			[]string{"username", "display_name", "email", "bio", "website",
				"location", "avatar_url", "avatar_media_id", "group_name", "quota", "used_quota"},
			[][]driver.Value{{u.username, u.displayName, u.email, u.bio, u.website,
				u.location, u.avatarURL, u.avatarMediaID, u.groupName, u.quota, u.usedQuota}},
		}, nil

	case strings.Contains(qn, "SELECT COUNT(*) FROM USERS WHERE EMAIL = ? AND ID <> ?"):
		email := handlerStr(vals[0])
		uid := handlerInt(vals[1])
		var n int64
		for id, u := range d.users {
			if id != uid && u.email == email {
				n++
			}
		}
		return &mediaHandlerRows{[]string{"n"}, [][]driver.Value{{n}}}, nil

	default:
		return &mediaHandlerRows{columns: []string{"value"}}, nil
	}
}

func handlerMediaColumns() []string {
	return []string{"id", "user_id", "sha256", "size", "mime", "kind", "ext", "orig_name",
		"source", "width", "height", "ref_count", "status", "deleted_at", "last_access_at", "created_at"}
}

func handlerMediaValues(r *mediaHandlerRow) []driver.Value {
	var deleted any
	if r.deleted != nil {
		deleted = *r.deleted
	}
	return []driver.Value{r.id, r.userID, r.sha256, r.size, r.mime, r.kind, r.ext, r.origName,
		r.source, r.width, r.height, r.refCount, r.status, deleted, nil, r.created}
}

var mediaHandlerDriverSeq atomic.Uint64

// useMediaHandlerDB 安装内存驱动并返回句柄。
func useMediaHandlerDB(t *testing.T) *mediaHandlerTestDriver {
	t.Helper()
	d := newMediaHandlerDriver()
	name := fmt.Sprintf("media-handler-test-%d", mediaHandlerDriverSeq.Add(1))
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

// mediaCtx 造一个带身份（或匿名）的 gin 测试上下文。
func mediaCtx(method, target string, body io.Reader, user *models.User, role authz.Role) (*gin.Context, *httptest.ResponseRecorder) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(method, target, body)
	if user != nil {
		c.Set(middleware.CtxUserKey, user)
		c.Set(middleware.CtxRoleKey, role)
	}
	return c, rec
}

func decodeMediaResponse(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, rec.Body.String())
	}
	return out
}

func mediaResponseData(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	out := decodeMediaResponse(t, rec)
	data, _ := out["data"].(map[string]any)
	return data
}

func multipartFile(t *testing.T, content []byte, filename string, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	buf := &bytes.Buffer{}
	w := multipart.NewWriter(buf)
	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(content); err != nil {
		t.Fatal(err)
	}
	for k, v := range fields {
		_ = w.WriteField(k, v)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf, w.FormDataContentType()
}

func pngFixture(width, height uint32) []byte {
	b := make([]byte, 33)
	copy(b, []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a})
	copy(b[8:], []byte{0, 0, 0, 13, 'I', 'H', 'D', 'R'})
	binary.BigEndian.PutUint32(b[16:], width)
	binary.BigEndian.PutUint32(b[20:], height)
	return b
}

// prepareMediaTest 安装内存库与临时存储根，并固定 JWT 密钥。
func prepareMediaTest(t *testing.T) *mediaHandlerTestDriver {
	t.Helper()
	services.SetMediaRoot(t.TempDir())
	services.SetJWTSecret("handler-media-secret")
	t.Cleanup(func() {
		services.SetMediaRoot("")
		services.SetJWTSecret("")
	})
	return useMediaHandlerDB(t)
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

func TestMediaUploadMultipartAndDedupe(t *testing.T) {
	d := prepareMediaTest(t)
	user := &models.User{ID: 5, Username: "alice", DisplayName: "Alice"}

	body, contentType := multipartFile(t, pngFixture(120, 60), "photo.png", map[string]string{"source": "chat"})
	c, rec := mediaCtx(http.MethodPost, "/api/media", body, user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", contentType)
	MediaUpload(c)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	resp := decodeMediaResponse(t, rec)
	if resp["success"] != true {
		t.Fatalf("upload failed: %s", rec.Body.String())
	}
	data := mediaResponseData(t, rec)
	if data["deduped"] != false || data["mime"] != "image/png" || data["kind"] != "image" || data["ext"] != "png" {
		t.Fatalf("bad upload payload: %+v", data)
	}
	if data["width"].(float64) != 120 || data["height"].(float64) != 60 {
		t.Fatalf("dims = %vx%v", data["width"], data["height"])
	}
	if data["source"] != "chat" {
		t.Fatalf("source = %v", data["source"])
	}
	url, _ := data["url"].(string)
	if !strings.HasPrefix(url, "/api/media/1/raw?s=") {
		t.Fatalf("url = %q", url)
	}
	quota, _ := data["quota"].(map[string]any)
	if quota == nil || quota["used_bytes"].(float64) == 0 {
		t.Fatalf("quota payload missing: %+v", data)
	}
	if len(d.rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(d.rows))
	}

	// 同内容再传：同 id + deduped=true，且不新增行。
	body2, contentType2 := multipartFile(t, pngFixture(120, 60), "again.png", nil)
	c2, rec2 := mediaCtx(http.MethodPost, "/api/media", body2, user, authz.RoleUser)
	c2.Request.Header.Set("Content-Type", contentType2)
	MediaUpload(c2)
	data2 := mediaResponseData(t, rec2)
	if data2["deduped"] != true || data2["id"].(float64) != data["id"].(float64) {
		t.Fatalf("dedupe failed: %+v", data2)
	}
	if len(d.rows) != 1 {
		t.Fatalf("dedupe inserted a new row: %d", len(d.rows))
	}
}

func TestMediaUploadRejectsSVGAndOversize(t *testing.T) {
	prepareMediaTest(t)
	user := &models.User{ID: 5}

	body, contentType := multipartFile(t, []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "evil.svg", nil)
	c, rec := mediaCtx(http.MethodPost, "/api/media", body, user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", contentType)
	MediaUpload(c)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("svg upload status = %d, want 415: %s", rec.Code, rec.Body.String())
	}
	if decodeMediaResponse(t, rec)["success"] != false {
		t.Fatal("svg upload reported success")
	}
}

func TestMediaUploadRequiresAuth(t *testing.T) {
	prepareMediaTest(t)
	body, contentType := multipartFile(t, pngFixture(1, 1), "x.png", nil)
	c, rec := mediaCtx(http.MethodPost, "/api/media", body, nil, authz.RoleGuest)
	c.Request.Header.Set("Content-Type", contentType)
	MediaUpload(c)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous upload status = %d, want 401", rec.Code)
	}
}

// ---------------------------------------------------------------------------
// 列表 / 统计 / 详情
// ---------------------------------------------------------------------------

func TestMediaListScopesToSelfForNormalUser(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, size: 10, mime: "image/png", kind: "image", ext: "png", origName: "mine.png", status: 1, created: time.Now()}
	d.rows[2] = &mediaHandlerRow{id: 2, userID: 9, size: 20, mime: "image/png", kind: "image", ext: "png", origName: "theirs.png", status: 1, created: time.Now()}
	d.rows[3] = &mediaHandlerRow{id: 3, userID: 5, size: 30, mime: "application/pdf", kind: "file", ext: "pdf", origName: "doc.pdf", status: 2, created: time.Now()}

	user := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodGet, "/api/media?p=1&page_size=10", nil, user, authz.RoleUser)
	MediaList(c)

	data := mediaResponseData(t, rec)
	if data["total"].(float64) != 1 {
		t.Fatalf("total = %v, want 1 (self only, status=1)", data["total"])
	}
	items, _ := data["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("items = %v", items)
	}
	item := items[0].(map[string]any)
	if item["orig_name"] != "mine.png" || item["id"].(float64) != 1 {
		t.Fatalf("wrong item: %+v", item)
	}
	if _, ok := item["sha256"]; ok {
		t.Fatal("list leaked sha256")
	}

	// 普通用户即便传 user_id 也只能看自己。
	c2, rec2 := mediaCtx(http.MethodGet, "/api/media?user_id=9", nil, user, authz.RoleUser)
	MediaList(c2)
	if data2 := mediaResponseData(t, rec2); data2["total"].(float64) != 1 {
		t.Fatalf("non-admin escalated scope: %+v", data2)
	}

	// 管理员可以看全站（status 默认仍是 1）。
	admin := &models.User{ID: 1, Role: 100}
	c3, rec3 := mediaCtx(http.MethodGet, "/api/media?user_id=9", nil, admin, authz.RoleAdmin)
	MediaList(c3)
	data3 := mediaResponseData(t, rec3)
	if data3["total"].(float64) != 1 {
		t.Fatalf("admin user filter failed: %+v", data3)
	}

	// 管理员查软删行：status=2 应看到第 3 行。
	c4, rec4 := mediaCtx(http.MethodGet, "/api/media?status=2", nil, admin, authz.RoleAdmin)
	MediaList(c4)
	data4 := mediaResponseData(t, rec4)
	if data4["total"].(float64) != 1 {
		t.Fatalf("admin status filter failed: %+v", data4)
	}
}

func TestMediaListKindAndNameFilters(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, size: 10, kind: "image", ext: "png", origName: "cat.png", status: 1, created: time.Now()}
	d.rows[2] = &mediaHandlerRow{id: 2, userID: 5, size: 20, kind: "file", ext: "pdf", origName: "dog.pdf", status: 1, created: time.Now()}

	user := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodGet, "/api/media?kind=file", nil, user, authz.RoleUser)
	MediaList(c)
	if data := mediaResponseData(t, rec); data["total"].(float64) != 1 {
		t.Fatalf("kind filter failed: %+v", data)
	}

	c2, rec2 := mediaCtx(http.MethodGet, "/api/media?q=cat", nil, user, authz.RoleUser)
	MediaList(c2)
	data := mediaResponseData(t, rec2)
	if data["total"].(float64) != 1 {
		t.Fatalf("name filter failed: %+v", data)
	}
	items := data["items"].([]any)
	if items[0].(map[string]any)["orig_name"] != "cat.png" {
		t.Fatalf("wrong name-filtered item: %+v", items[0])
	}
}

func TestMediaStatsScopes(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, size: 100, kind: "image", status: 1, created: time.Now()}
	d.rows[2] = &mediaHandlerRow{id: 2, userID: 5, size: 200, kind: "file", status: 1, created: time.Now()}
	d.rows[3] = &mediaHandlerRow{id: 3, userID: 9, size: 400, kind: "image", status: 1, created: time.Now()}
	d.rows[4] = &mediaHandlerRow{id: 4, userID: 5, size: 800, kind: "image", status: 2, created: time.Now()}

	user := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodGet, "/api/media/stats", nil, user, authz.RoleUser)
	MediaStats(c)
	data := mediaResponseData(t, rec)
	if data["scope"] != "self" || data["count"].(float64) != 2 || data["bytes"].(float64) != 300 {
		t.Fatalf("self stats = %+v", data)
	}
	if data["enabled"] != true {
		t.Fatalf("enabled flag missing: %+v", data)
	}
	if data["max_file_bytes"].(float64) != 10*1024*1024 {
		t.Fatalf("max_file_bytes = %v", data["max_file_bytes"])
	}
	if data["quota_bytes"].(float64) != 1024*1024*1024 {
		t.Fatalf("quota_bytes = %v", data["quota_bytes"])
	}
	byKind, _ := data["by_kind"].([]any)
	if len(byKind) != 2 {
		t.Fatalf("by_kind = %+v", byKind)
	}

	admin := &models.User{ID: 1, Role: 100}
	c2, rec2 := mediaCtx(http.MethodGet, "/api/media/stats", nil, admin, authz.RoleAdmin)
	MediaStats(c2)
	data2 := mediaResponseData(t, rec2)
	if data2["scope"] != "all" || data2["count"].(float64) != 3 || data2["bytes"].(float64) != 700 {
		t.Fatalf("all stats = %+v", data2)
	}

	c3, rec3 := mediaCtx(http.MethodGet, "/api/media/stats?user_id=9", nil, admin, authz.RoleAdmin)
	MediaStats(c3)
	if data3 := mediaResponseData(t, rec3); data3["scope"] != "user" || data3["count"].(float64) != 1 {
		t.Fatalf("user stats = %+v", data3)
	}
}

func TestMediaDetailOwnership(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, sha256: strings.Repeat("a", 64), size: 10, mime: "image/png", kind: "image", ext: "png", status: 1, created: time.Now()}

	owner := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodGet, "/api/media/1", nil, owner, authz.RoleUser)
	c.Params = gin.Params{{Key: "id", Value: "1"}}
	MediaDetail(c)
	data := mediaResponseData(t, rec)
	if data["sha256"] != strings.Repeat("a", 64) {
		t.Fatalf("detail = %+v", data)
	}

	other := &models.User{ID: 6}
	c2, rec2 := mediaCtx(http.MethodGet, "/api/media/1", nil, other, authz.RoleUser)
	c2.Params = gin.Params{{Key: "id", Value: "1"}}
	MediaDetail(c2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("other user got %d, want 403", rec2.Code)
	}

	c3, rec3 := mediaCtx(http.MethodGet, "/api/media/999", nil, owner, authz.RoleUser)
	c3.Params = gin.Params{{Key: "id", Value: "999"}}
	MediaDetail(c3)
	if rec3.Code != http.StatusNotFound {
		t.Fatalf("missing media got %d, want 404", rec3.Code)
	}
}

// ---------------------------------------------------------------------------
// 改名 / 删除（含引用阻塞与强制删除）
// ---------------------------------------------------------------------------

func TestMediaRenameValidatesLengthAndOwnership(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, sha256: strings.Repeat("b", 64), size: 10, mime: "image/png", kind: "image", ext: "png", origName: "old.png", status: 1, created: time.Now()}

	owner := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodPatch, "/api/media/1", strings.NewReader(`{"orig_name":"  新名字.png  "}`), owner, authz.RoleUser)
	c.Params = gin.Params{{Key: "id", Value: "1"}}
	c.Request.Header.Set("Content-Type", "application/json")
	MediaRename(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("rename status = %d: %s", rec.Code, rec.Body.String())
	}
	if d.rows[1].origName != "新名字.png" {
		t.Fatalf("orig_name = %q", d.rows[1].origName)
	}

	var long []rune
	for i := 0; i < 256; i++ {
		long = append(long, 'x')
	}
	c2, rec2 := mediaCtx(http.MethodPatch, "/api/media/1", strings.NewReader(fmt.Sprintf(`{"orig_name":%q}`, string(long))), owner, authz.RoleUser)
	c2.Params = gin.Params{{Key: "id", Value: "1"}}
	c2.Request.Header.Set("Content-Type", "application/json")
	MediaRename(c2)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("overlong name got %d, want 400", rec2.Code)
	}
}

func TestMediaDeleteBlockedByRefsThenForced(t *testing.T) {
	d := prepareMediaTest(t)
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, sha256: strings.Repeat("c", 64), size: 10, mime: "image/png", kind: "image", ext: "png", status: 1, refCount: 1, created: time.Now()}
	d.refs = append(d.refs, &mediaHandlerRef{mediaID: 1, userID: 5, refType: "post", refID: "42", live: true})

	owner := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodDelete, "/api/media/1", nil, owner, authz.RoleUser)
	c.Params = gin.Params{{Key: "id", Value: "1"}}
	MediaDelete(c)

	if rec.Code != http.StatusConflict {
		t.Fatalf("blocked delete status = %d, want 409: %s", rec.Code, rec.Body.String())
	}
	resp := decodeMediaResponse(t, rec)
	if resp["success"] != false {
		t.Fatal("blocked delete reported success")
	}
	data, _ := resp["data"].(map[string]any)
	refs, _ := data["refs"].([]any)
	if len(refs) != 1 {
		t.Fatalf("refs = %+v", data["refs"])
	}
	ref := refs[0].(map[string]any)
	if ref["ref_type"] != "post" || ref["ref_id"] != "42" {
		t.Fatalf("ref payload = %+v", ref)
	}
	if d.rows[1].status != 1 {
		t.Fatal("blocked delete still changed status")
	}

	// 普通用户带 force=1 无效。
	c2, rec2 := mediaCtx(http.MethodDelete, "/api/media/1?force=1", nil, owner, authz.RoleUser)
	c2.Params = gin.Params{{Key: "id", Value: "1"}}
	MediaDelete(c2)
	if rec2.Code != http.StatusConflict {
		t.Fatalf("non-admin force got %d, want 409", rec2.Code)
	}

	// 管理员 force=1：解绑活引用并软删。
	admin := &models.User{ID: 1, Role: 100}
	c3, rec3 := mediaCtx(http.MethodDelete, "/api/media/1?force=1", nil, admin, authz.RoleAdmin)
	c3.Params = gin.Params{{Key: "id", Value: "1"}}
	MediaDelete(c3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("admin force delete status = %d: %s", rec3.Code, rec3.Body.String())
	}
	if d.rows[1].status != 2 || d.rows[1].refCount != 0 {
		t.Fatalf("force delete state = status %d ref_count %d", d.rows[1].status, d.rows[1].refCount)
	}
	live := 0
	for _, r := range d.refs {
		if r.live {
			live++
		}
	}
	if live != 0 {
		t.Fatalf("force delete left %d live refs", live)
	}
	data3 := mediaResponseData(t, rec3)
	if data3["status"].(float64) != 2 {
		t.Fatalf("delete payload = %+v", data3)
	}
}

// ---------------------------------------------------------------------------
// 原始文件流
// ---------------------------------------------------------------------------

func TestMediaRawSignatureOwnershipAndStatus(t *testing.T) {
	d := prepareMediaTest(t)
	saved, err := services.SaveBuffer(services.SaveMediaInput{
		Buffer: pngFixture(8, 8), UserID: 5, OrigName: "a.png", Source: "chat",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(d.rows) != 1 {
		t.Fatalf("rows = %d", len(d.rows))
	}

	// 1) 匿名 + 有效签名 → 200，正确头。
	sig := services.SignMedia(saved.ID)
	c, rec := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw?s=%s", saved.ID, sig), nil, nil, authz.RoleGuest)
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("signed raw status = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("cache-control = %q", cc)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("nosniff missing")
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != "" {
		t.Fatalf("image should render inline, got %q", cd)
	}
	if !bytes.Equal(rec.Body.Bytes(), pngFixture(8, 8)) {
		t.Fatal("raw body mismatch")
	}

	// 2) 匿名 + 无效签名 → 403。
	c2, rec2 := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw?s=deadbeef.00000000", saved.ID), nil, nil, authz.RoleGuest)
	c2.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("bad signature status = %d, want 403", rec2.Code)
	}

	// 3) 匿名无签名 → 403。
	c3, rec3 := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw", saved.ID), nil, nil, authz.RoleGuest)
	c3.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c3)
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("anonymous raw status = %d, want 403", rec3.Code)
	}

	// 4) 本人无签名 → 200。
	owner := &models.User{ID: 5}
	c4, rec4 := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw", saved.ID), nil, owner, authz.RoleUser)
	c4.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c4)
	if rec4.Code != http.StatusOK {
		t.Fatalf("owner raw status = %d", rec4.Code)
	}

	// 5) 他人无签名 → 403。
	other := &models.User{ID: 6}
	c5, rec5 := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw", saved.ID), nil, other, authz.RoleUser)
	c5.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c5)
	if rec5.Code != http.StatusForbidden {
		t.Fatalf("other user raw status = %d, want 403", rec5.Code)
	}

	// 6) 已软删 → 410（签名仍然有效时）。
	d.rows[saved.ID].status = 2
	c6, rec6 := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw?s=%s", saved.ID, services.SignMedia(saved.ID)), nil, nil, authz.RoleGuest)
	c6.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c6)
	if rec6.Code != http.StatusGone {
		t.Fatalf("deleted raw status = %d, want 410", rec6.Code)
	}

	// 7) 不存在 → 404。
	c7, rec7 := mediaCtx(http.MethodGet, "/api/media/999/raw", nil, nil, authz.RoleGuest)
	c7.Params = gin.Params{{Key: "id", Value: "999"}}
	MediaRaw(c7)
	if rec7.Code != http.StatusNotFound {
		t.Fatalf("missing raw status = %d, want 404", rec7.Code)
	}
}

func TestMediaRawForcesAttachmentForNonImages(t *testing.T) {
	prepareMediaTest(t)
	saved, err := services.SaveBuffer(services.SaveMediaInput{
		Buffer: []byte("%PDF-1.4\n"), UserID: 5, OrigName: "文档.pdf", Source: "upload",
	})
	if err != nil {
		t.Fatal(err)
	}
	c, rec := mediaCtx(http.MethodGet, fmt.Sprintf("/api/media/%d/raw?s=%s", saved.ID, services.SignMedia(saved.ID)), nil, nil, authz.RoleGuest)
	c.Params = gin.Params{{Key: "id", Value: fmt.Sprint(saved.ID)}}
	MediaRaw(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("pdf raw status = %d", rec.Code)
	}
	cd := rec.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, "attachment;") {
		t.Fatalf("pdf should be an attachment, got %q", cd)
	}
	if !strings.Contains(cd, "%E6%96%87%E6%A1%A3.pdf") {
		t.Fatalf("filename* encoding wrong: %q", cd)
	}

	// ?download=1 让图片也走附件下载。
	img, err := services.SaveBuffer(services.SaveMediaInput{Buffer: pngFixture(2, 2), UserID: 5, OrigName: "p.png"})
	if err != nil {
		t.Fatal(err)
	}
	c2, rec2 := mediaCtx(http.MethodGet,
		fmt.Sprintf("/api/media/%d/raw?s=%s&download=1", img.ID, services.SignMedia(img.ID)), nil, nil, authz.RoleGuest)
	c2.Params = gin.Params{{Key: "id", Value: fmt.Sprint(img.ID)}}
	MediaRaw(c2)
	if cd := rec2.Header().Get("Content-Disposition"); !strings.HasPrefix(cd, "attachment;") {
		t.Fatalf("download=1 should force attachment, got %q", cd)
	}
}

// ---------------------------------------------------------------------------
// 头像
// ---------------------------------------------------------------------------

func TestMediaAvatarUploadAndDelete(t *testing.T) {
	d := prepareMediaTest(t)
	d.users[5] = &mediaHandlerUser{username: "alice", displayName: "Alice", groupName: "default"}
	user := &models.User{ID: 5, Username: "alice"}

	body, contentType := multipartFile(t, pngFixture(64, 64), "avatar.png", nil)
	c, rec := mediaCtx(http.MethodPost, "/api/media/avatar", body, user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", contentType)
	MediaAvatarUpload(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("avatar upload status = %d: %s", rec.Code, rec.Body.String())
	}
	data := mediaResponseData(t, rec)
	wantURL := "/api/media/avatar/5?v=1"
	if data["avatar_url"] != wantURL {
		t.Fatalf("avatar_url = %v, want %s", data["avatar_url"], wantURL)
	}
	if d.users[5].avatarMediaID != 1 || d.users[5].avatarURL != wantURL {
		t.Fatalf("user row not updated: %+v", d.users[5])
	}
	liveRefs := 0
	for _, r := range d.refs {
		if r.live && r.refType == "avatar" {
			liveRefs++
		}
	}
	if liveRefs != 1 {
		t.Fatalf("avatar refs = %d, want 1", liveRefs)
	}

	// 公开头像流：匿名可取。
	c2, rec2 := mediaCtx(http.MethodGet, "/api/media/avatar/5", nil, nil, authz.RoleGuest)
	c2.Params = gin.Params{{Key: "userId", Value: "5"}}
	MediaAvatar(c2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("avatar raw status = %d", rec2.Code)
	}
	if cc := rec2.Header().Get("Cache-Control"); !strings.Contains(cc, "public") {
		t.Fatalf("avatar cache-control = %q", cc)
	}
	if !bytes.Equal(rec2.Body.Bytes(), pngFixture(64, 64)) {
		t.Fatal("avatar body mismatch")
	}

	// 无头像用户 → 404。
	c3, rec3 := mediaCtx(http.MethodGet, "/api/media/avatar/9", nil, nil, authz.RoleGuest)
	c3.Params = gin.Params{{Key: "userId", Value: "9"}}
	MediaAvatar(c3)
	if rec3.Code != http.StatusNotFound {
		t.Fatalf("no-avatar status = %d, want 404", rec3.Code)
	}

	// 删除头像：解绑引用并清空自定义头像。
	// 该用户没有三方绑定，因此回退值为空串（前端用姓名首字母）。
	c4, rec4 := mediaCtx(http.MethodDelete, "/api/media/avatar", nil, user, authz.RoleUser)
	MediaAvatarDelete(c4)
	if rec4.Code != http.StatusOK {
		t.Fatalf("avatar delete status = %d", rec4.Code)
	}
	if d.users[5].avatarMediaID != 0 || d.users[5].avatarURL != "" {
		t.Fatalf("avatar not cleared: %+v", d.users[5])
	}
	for _, r := range d.refs {
		if r.live && r.refType == "avatar" {
			t.Fatal("avatar ref still live after delete")
		}
	}
}

// 有平台头像的用户：移除自定义头像后回退到平台头像，而不是一概清空。
func TestMediaAvatarDeleteFallsBackToProviderAvatar(t *testing.T) {
	d := prepareMediaTest(t)
	d.users[5] = &mediaHandlerUser{
		username:    "alice",
		displayName: "Alice",
		groupName:   "default",
		avatarURL:   "https://avatars.example.com/alice.png",
	}
	d.bindings = append(d.bindings, mediaHandlerBinding{userID: 5, avatar: "https://avatars.example.com/alice.png"})
	user := &models.User{ID: 5, Username: "alice"}

	body, contentType := multipartFile(t, pngFixture(64, 64), "avatar.png", nil)
	c, rec := mediaCtx(http.MethodPost, "/api/media/avatar", body, user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", contentType)
	MediaAvatarUpload(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("avatar upload status = %d: %s", rec.Code, rec.Body.String())
	}

	c2, rec2 := mediaCtx(http.MethodDelete, "/api/media/avatar", nil, user, authz.RoleUser)
	MediaAvatarDelete(c2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("avatar delete status = %d", rec2.Code)
	}
	if d.users[5].avatarMediaID != 0 {
		t.Fatalf("avatarMediaID not cleared: %+v", d.users[5])
	}
	if d.users[5].avatarURL != "https://avatars.example.com/alice.png" {
		t.Fatalf("did not fall back to provider avatar: %+v", d.users[5])
	}
}

func TestMediaAvatarUploadRejectsOversizeAndNonImage(t *testing.T) {
	prepareMediaTest(t)
	user := &models.User{ID: 5}

	// 伪造一张超过 512KB 的图片（内容合法但体积超限）。
	big := pngFixture(8, 8)
	big = append(big, bytes.Repeat([]byte{0}, 513*1024)...)
	body, contentType := multipartFile(t, big, "big.png", nil)
	c, rec := mediaCtx(http.MethodPost, "/api/media/avatar", body, user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", contentType)
	MediaAvatarUpload(c)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize avatar status = %d, want 413: %s", rec.Code, rec.Body.String())
	}

	// PDF 不是图片，不能当头像。
	body2, contentType2 := multipartFile(t, []byte("%PDF-1.4\n"), "doc.pdf", nil)
	c2, rec2 := mediaCtx(http.MethodPost, "/api/media/avatar", body2, user, authz.RoleUser)
	c2.Request.Header.Set("Content-Type", contentType2)
	MediaAvatarUpload(c2)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("pdf avatar status = %d, want 400: %s", rec2.Code, rec2.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 回收
// ---------------------------------------------------------------------------

func TestMediaGCRequiresAdmin(t *testing.T) {
	d := prepareMediaTest(t)

	user := &models.User{ID: 5}
	c, rec := mediaCtx(http.MethodPost, "/api/media/gc", strings.NewReader(`{"limit":10}`), user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", "application/json")
	MediaGC(c)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin gc status = %d, want 403", rec.Code)
	}

	// 管理员：把孤儿行推到 24h 前，回收应把它软删。
	d.rows[1] = &mediaHandlerRow{id: 1, userID: 5, sha256: strings.Repeat("d", 64), size: 5, kind: "file", ext: "txt", status: 1, created: time.Now().Add(-48 * time.Hour)}
	admin := &models.User{ID: 1, Role: 100}
	c2, rec2 := mediaCtx(http.MethodPost, "/api/media/gc", strings.NewReader(`{"limit":10}`), admin, authz.RoleAdmin)
	c2.Request.Header.Set("Content-Type", "application/json")
	MediaGC(c2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("admin gc status = %d: %s", rec2.Code, rec2.Body.String())
	}
	data := mediaResponseData(t, rec2)
	if data["soft_deleted"].(float64) != 1 {
		t.Fatalf("gc payload = %+v", data)
	}
}

// ---------------------------------------------------------------------------
// 个人资料
// ---------------------------------------------------------------------------

func TestUpdateProfilePersistsExtendedFields(t *testing.T) {
	d := prepareMediaTest(t)
	d.users[5] = &mediaHandlerUser{username: "alice", displayName: "Alice", email: "a@example.com", groupName: "default"}

	user := &models.User{ID: 5, Username: "alice", DisplayName: "Alice", Email: "a@example.com"}
	body := `{"display_name":"Alice2","email":"a2@example.com","bio":"第一行\n第二行","website":"https://example.com/me","location":"上海"}`
	c, rec := mediaCtx(http.MethodPut, "/api/user/profile", strings.NewReader(body), user, authz.RoleUser)
	c.Request.Header.Set("Content-Type", "application/json")
	UpdateProfile(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("profile update status = %d: %s", rec.Code, rec.Body.String())
	}
	data := mediaResponseData(t, rec)
	if data["bio"] != "第一行\n第二行" || data["website"] != "https://example.com/me" || data["location"] != "上海" {
		t.Fatalf("profile payload = %+v", data)
	}
	if d.users[5].bio != "第一行\n第二行" || d.users[5].website != "https://example.com/me" || d.users[5].location != "上海" {
		t.Fatalf("profile not persisted: %+v", d.users[5])
	}

	// 非 http/https 的网站必须拒绝（javascript: 会挂在前端 <a href> 上执行）。
	bad := `{"display_name":"Alice2","website":"javascript:alert(1)"}`
	c2, rec2 := mediaCtx(http.MethodPut, "/api/user/profile", strings.NewReader(bad), user, authz.RoleUser)
	c2.Request.Header.Set("Content-Type", "application/json")
	UpdateProfile(c2)
	if rec2.Code != http.StatusBadRequest {
		t.Fatalf("javascript: website got %d, want 400", rec2.Code)
	}

	// 空串清空字段。
	clear := `{"display_name":"Alice2","bio":"","website":"","location":""}`
	c3, rec3 := mediaCtx(http.MethodPut, "/api/user/profile", strings.NewReader(clear), user, authz.RoleUser)
	c3.Request.Header.Set("Content-Type", "application/json")
	UpdateProfile(c3)
	if rec3.Code != http.StatusOK {
		t.Fatalf("clear status = %d", rec3.Code)
	}
	if d.users[5].bio != "" || d.users[5].website != "" || d.users[5].location != "" {
		t.Fatalf("fields not cleared: %+v", d.users[5])
	}
}

func TestUserProfileEndpointShape(t *testing.T) {
	d := prepareMediaTest(t)
	d.users[5] = &mediaHandlerUser{
		username: "alice", displayName: "Alice", email: "a@example.com",
		bio: "hi", website: "https://example.com", location: "上海",
		avatarMediaID: 7, groupName: "default", quota: 100, usedQuota: 20,
	}

	user := &models.User{ID: 5, Username: "alice", Role: 1}
	c, rec := mediaCtx(http.MethodGet, "/api/user/profile", nil, user, authz.RoleUser)
	UserProfile(c)
	if rec.Code != http.StatusOK {
		t.Fatalf("profile status = %d: %s", rec.Code, rec.Body.String())
	}
	data := mediaResponseData(t, rec)
	for key, want := range map[string]any{
		"username": "alice", "display_name": "Alice", "email": "a@example.com",
		"bio": "hi", "website": "https://example.com", "location": "上海",
		"avatar_url": "/api/media/avatar/5?v=7", "group_name": "default",
		"quota": float64(100), "used_quota": float64(20), "role_name": "普通用户",
	} {
		if data[key] != want {
			t.Fatalf("profile[%s] = %v, want %v", key, data[key], want)
		}
	}
}
