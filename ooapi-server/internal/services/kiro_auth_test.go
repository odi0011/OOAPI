package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"ooapi/internal/db"
)

func useTestSecret(t *testing.T) {
	t.Helper()
	old := JWTSecret()
	SetJWTSecret("device-test-master")
	t.Cleanup(func() { SetJWTSecret(old) })
}

// overrideKiroEndpoints 把三个 OIDC 端点指到 mock 服务器（测试结束后还原）。
func overrideKiroEndpoints(t *testing.T, server *httptest.Server) {
	t.Helper()
	reg, dev, tok := kiroOIDCRegisterURL, kiroOIDCDeviceURL, kiroOIDCTokenURL
	kiroOIDCRegisterURL = func(string) string { return server.URL + "/client/register" }
	kiroOIDCDeviceURL = func(string) string { return server.URL + "/device_authorization" }
	kiroOIDCTokenURL = func(string) string { return server.URL + "/token" }
	t.Cleanup(func() {
		kiroOIDCRegisterURL, kiroOIDCDeviceURL, kiroOIDCTokenURL = reg, dev, tok
	})
}

func TestKiroRegionSafetyAndModelMapping(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"us-west-2", "us-west-2"},
		{"US-EAST-1", "us-east-1"},
		{"  eu-central-1 ", "eu-central-1"},
		{"@127.0.0.1:8080/", "us-east-1"},
		{"evil.example.com", "us-east-1"},
		{"", "us-east-1"},
	} {
		if got := KiroSafeRegion(tt.in); got != tt.want {
			t.Fatalf("KiroSafeRegion(%q)=%q want %q", tt.in, got, tt.want)
		}
	}
	if KiroRegionFromHost("codewhisperer.us-east-1.amazonaws.com") != "us-east-1" {
		t.Fatal("region host not parsed")
	}
	for _, host := range []string{"codewhisperer.evil.example.com", "codewhisperer.amazonaws.com", "codewhisperer..amazonaws.com", "oidc.us-east-1.amazonaws.com"} {
		if KiroRegionFromHost(host) != "" {
			t.Fatalf("unsafe host accepted: %s", host)
		}
	}
	if !IsKiroBaseURL("https://codewhisperer.us-east-1.amazonaws.com") || IsKiroBaseURL("http://codewhisperer.us-east-1.amazonaws.com") || IsKiroBaseURL("https://codewhisperer.us-east-1.amazonaws.com.evil.example") {
		t.Fatal("base url validation wrong")
	}
	for model, want := range map[string]string{
		"claude-opus-5":     "claude-opus-4.5",
		"claude-sonnet-5":   "claude-sonnet-4.5",
		"claude-haiku-4.5":  "claude-haiku-4.5",
		"":                  "claude-sonnet-4.5",
		"claude-sonnet-4-5": "claude-sonnet-4-5",
	} {
		if got := KiroModelID(model); got != want {
			t.Fatalf("KiroModelID(%q)=%q want %q", model, got, want)
		}
	}
	fp := KiroDeviceFingerprint(13)
	if len(fp) != 40 {
		t.Fatalf("bad fingerprint %q", fp)
	}
	if _, err := hex.DecodeString(fp); err != nil {
		t.Fatalf("fingerprint is not hex: %q", fp)
	}
	if fp == KiroDeviceFingerprint(14) {
		t.Fatal("fingerprint must depend on channel")
	}
}

func TestKiroJudgeTokenSemantics(t *testing.T) {
	for _, tt := range []struct {
		status int
		body   string
		want   string
		slow   bool
	}{
		{400, `{"error":"authorization_pending"}`, "pending", false},
		{400, `{"__type":"SlowDown"}`, "pending", true},
		{400, `{"error":"expired_token"}`, "expired", false},
		{400, `{"error":"access_denied"}`, "denied", false},
		{500, `{"message":"boom"}`, "pending", false},
		{200, `{"accessToken":"access","refreshToken":"refresh","expiresIn":1800}`, "success", false},
	} {
		t.Run(tt.body, func(t *testing.T) {
			var j map[string]any
			json.Unmarshal([]byte(tt.body), &j)
			out, cred := KiroJudgeToken(tt.status, j, KiroDeviceStart{Region: "us-west-2", ClientID: "cid", ClientSecret: "secret"})
			if out.Status != tt.want || out.SlowDown != tt.slow {
				t.Fatalf("got %#v", out)
			}
			if out.Status == "success" {
				if cred.AccessToken != "access" || cred.Region != "us-west-2" || cred.ClientID != "cid" || cred.ExpiresAt <= time.Now().Unix() {
					t.Fatalf("credential %#v", cred)
				}
			} else if cred.AccessToken != "" {
				t.Fatal("unexpected credential")
			}
		})
	}
}

func TestKiroDeviceStartAndPollSuccess(t *testing.T) {
	var tokenCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/client/register":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["clientName"] != "OOAPI Gateway" || body["clientType"] != "public" {
				t.Errorf("bad register body %v", body)
			}
			scopes, _ := body["scopes"].([]any)
			if len(scopes) != 5 {
				t.Errorf("bad scopes %v", body)
			}
			io.WriteString(w, `{"clientId":"cid","clientSecret":"csecret"}`)
		case "/device_authorization":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["clientId"] != "cid" || body["startUrl"] != KiroDefaultStartURL {
				t.Errorf("bad device body %v", body)
			}
			io.WriteString(w, `{"deviceCode":"dcode","userCode":"USER","verificationUriComplete":"https://view.awsapps.com/start/#/device?user_code=USER","interval":4,"expiresIn":600}`)
		case "/token":
			tokenCalls.Add(1)
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if body["grantType"] != kiroDeviceGrant || body["deviceCode"] != "dcode" {
				t.Errorf("bad token body %v", body)
			}
			io.WriteString(w, `{"accessToken":"at","refreshToken":"rt","expiresIn":1800}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)

	start, err := KiroStartDevice(context.Background(), "", "us-west-2")
	if err != nil {
		t.Fatal(err)
	}
	if start.Region != "us-west-2" || start.UserCode != "USER" || start.Interval != 4 || start.ExpiresIn != 600 {
		t.Fatalf("start %#v", start)
	}
	out, cred, err := KiroPollDevice(context.Background(), start)
	if err != nil || out.Status != "success" || cred.AccessToken != "at" || cred.RefreshToken != "rt" {
		t.Fatalf("poll %#v %#v %v", out, cred, err)
	}
	if tokenCalls.Load() != 1 {
		t.Fatal("token polled too often")
	}
}

func TestKiroDeviceStartTriesNextRegionOnDeviceError(t *testing.T) {
	var regions []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/client/register":
			io.WriteString(w, `{"clientId":"cid","clientSecret":"csecret"}`)
		case "/device_authorization":
			// 按调用序号模拟：第一次 400（startUrl 与 region 不匹配）
			if len(regions) == 0 {
				regions = append(regions, "first")
				w.WriteHeader(400)
				io.WriteString(w, `{"message":"Invalid start url"}`)
				return
			}
			regions = append(regions, "second")
			io.WriteString(w, `{"deviceCode":"dcode","userCode":"U","verificationUri":"https://view.awsapps.com/start/#/device","interval":5,"expiresIn":600}`)
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)
	start, err := KiroStartDevice(context.Background(), "https://view.awsapps.com/start", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(regions) != 2 || start.Region != KiroRegionCandidates[1] {
		t.Fatalf("region fallback wrong: %v region=%s", regions, start.Region)
	}
}

func TestKiroDeviceStartRejectsUnsafeVerificationURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/client/register":
			io.WriteString(w, `{"clientId":"cid","clientSecret":"csecret"}`)
		default:
			io.WriteString(w, `{"deviceCode":"dcode","verificationUriComplete":"https://evil.example/device"}`)
		}
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)
	if _, err := KiroStartDevice(context.Background(), "", "us-east-1"); err == nil {
		t.Fatal("unsafe verification URL accepted")
	}
}

// ---------- 刷新链路（单飞 + CAS） ----------

type kiroCredentialDB struct {
	mu                   sync.Mutex
	encrypted            string
	version              int64
	vendor, method, base string
	writes               int
}

var kiroTestDB *kiroCredentialDB
var registerKiroDB sync.Once

type kiroDBDriver struct{}
type kiroDBConn struct{}

func (kiroDBDriver) Open(string) (driver.Conn, error) { return kiroDBConn{}, nil }
func (kiroDBConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare not used")
}
func (kiroDBConn) Close() error              { return nil }
func (kiroDBConn) Begin() (driver.Tx, error) { return nil, errors.New("transaction not used") }
func (kiroDBConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if !strings.HasPrefix(query, "SELECT vendor, method, base_url") {
		return nil, errors.New("unexpected query")
	}
	kiroTestDB.mu.Lock()
	defer kiroTestDB.mu.Unlock()
	return &kiroDBRows{values: []driver.Value{kiroTestDB.vendor, kiroTestDB.method, kiroTestDB.base, kiroTestDB.encrypted, kiroTestDB.version}}, nil
}
func (kiroDBConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if !strings.Contains(query, "auth_version = auth_version + 1") {
		return nil, errors.New("unexpected update")
	}
	kiroTestDB.mu.Lock()
	defer kiroTestDB.mu.Unlock()
	if args[3].Value.(int64) != kiroTestDB.version {
		return driver.RowsAffected(0), nil
	}
	kiroTestDB.encrypted = args[0].Value.(string)
	kiroTestDB.version++
	kiroTestDB.writes++
	return driver.RowsAffected(1), nil
}

type kiroDBRows struct {
	values []driver.Value
	done   bool
}

func (*kiroDBRows) Columns() []string {
	return []string{"vendor", "method", "base_url", "auth_credential", "auth_version"}
}
func (*kiroDBRows) Close() error { return nil }
func (r *kiroDBRows) Next(dest []driver.Value) error {
	if r.done {
		return io.EOF
	}
	copy(dest, r.values)
	r.done = true
	return nil
}

func setupKiroDB(t *testing.T, cred KiroCredential) {
	t.Helper()
	registerKiroDB.Do(func() { sql.Register("kiro-auth-test", kiroDBDriver{}) })
	stored, err := EncryptKiroCredential(cred)
	if err != nil {
		t.Fatal(err)
	}
	kiroTestDB = &kiroCredentialDB{encrypted: stored, version: 1, vendor: "kiro", method: "kiro", base: KiroAPIBaseURL(cred.Region)}
	conn, err := sql.Open("kiro-auth-test", "")
	if err != nil {
		t.Fatal(err)
	}
	old := db.DB
	db.DB = conn
	t.Cleanup(func() { db.DB = old; conn.Close(); kiroTestDB = nil })
}

func TestKiroCredentialRefreshAndSingleFlight(t *testing.T) {
	useTestSecret(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["grantType"] != "refresh_token" || body["refreshToken"] != "old-refresh" {
			t.Errorf("bad refresh body %v", body)
		}
		calls.Add(1)
		io.WriteString(w, `{"accessToken":"fresh-access","refreshToken":"rotated-refresh","expiresIn":3600}`)
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)
	setupKiroDB(t, KiroCredential{AccessToken: "expired", RefreshToken: "old-refresh", Region: "us-east-1", ClientID: "cid", ClientSecret: "csecret", ExpiresAt: time.Now().Unix() - 60})

	var wg sync.WaitGroup
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cred, err := ResolveKiroCredential(context.Background(), 23)
			if err != nil || cred.AccessToken != "fresh-access" {
				t.Errorf("resolve %#v %v", cred, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 || kiroTestDB.writes != 1 {
		t.Fatalf("duplicate refresh calls=%d writes=%d", calls.Load(), kiroTestDB.writes)
	}
	cred, err := DecryptKiroCredential(kiroTestDB.encrypted)
	if err != nil || cred.RefreshToken != "rotated-refresh" || strings.Contains(kiroTestDB.encrypted, "fresh-access") {
		t.Fatal("refresh persisted incorrectly")
	}
}

func TestKiroCredentialRejectsForeignChannelAndBase(t *testing.T) {
	useTestSecret(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("invalid channel reached refresh upstream")
	}))
	defer server.Close()
	overrideKiroEndpoints(t, server)
	setupKiroDB(t, KiroCredential{AccessToken: "access", RefreshToken: "rt", Region: "us-east-1", ExpiresAt: time.Now().Unix() + 3600})
	kiroTestDB.method = "api"
	if _, err := ResolveKiroCredential(context.Background(), 25); err == nil {
		t.Fatal("API key channel treated as device OAuth")
	}
	kiroTestDB.method = "kiro"
	kiroTestDB.base = "https://codewhisperer.us-east-1.amazonaws.com.evil.example"
	if _, err := ResolveKiroCredential(context.Background(), 25); err == nil {
		t.Fatal("credential sent to non-official host")
	}
	kiroTestDB.base = KiroAPIBaseURL("us-east-1")
	if _, err := ResolveKiroCredential(context.Background(), 25); err != nil {
		t.Fatalf("valid credential rejected: %v", err)
	}
}
