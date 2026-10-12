package services

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"ooapi/internal/cryptoutil"
	"ooapi/internal/db"
)

// 内存驱动只认迁移用到的两条查询和两条回写，用来证明：
// 明文会被加密、第二轮不再改写、单行失败不会挡住其他行、网关查找仍然对得上。

type migrateTokenRow struct {
	id      int64
	apiKey  string
	keyHash string
}

type migrateChannelRow struct {
	id     int64
	apiKey string
}

type keyMigrateDriver struct {
	mu             sync.Mutex
	tokens         []migrateTokenRow
	channels       []migrateChannelRow
	failTokenID    int64
	failChannelID  int64
	tokenUpdates   int
	channelUpdates int
}

func (d *keyMigrateDriver) Open(string) (driver.Conn, error) { return &keyMigrateConn{d}, nil }

type keyMigrateConn struct{ d *keyMigrateDriver }

func (c *keyMigrateConn) Prepare(string) (driver.Stmt, error) {
	return nil, fmt.Errorf("unexpected Prepare")
}
func (c *keyMigrateConn) Close() error              { return nil }
func (c *keyMigrateConn) Begin() (driver.Tx, error) { return nil, fmt.Errorf("unexpected Begin") }

func (c *keyMigrateConn) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	qn := normalizeSQL(q)
	switch {
	case strings.Contains(qn, "FROM TOKENS"):
		values := make([][]driver.Value, 0, len(d.tokens))
		for _, row := range d.tokens {
			if row.apiKey == "" {
				continue
			}
			values = append(values, []driver.Value{row.id, row.apiKey, row.keyHash})
		}
		return &keyMigrateRows{columns: []string{"id", "api_key", "key_hash"}, values: values}, nil
	case strings.Contains(qn, "FROM CHANNELS"):
		values := make([][]driver.Value, 0, len(d.channels))
		for _, row := range d.channels {
			if row.apiKey == "" {
				continue
			}
			values = append(values, []driver.Value{row.id, row.apiKey})
		}
		return &keyMigrateRows{columns: []string{"id", "api_key"}, values: values}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", q)
	}
}

func (c *keyMigrateConn) ExecContext(_ context.Context, q string, args []driver.NamedValue) (driver.Result, error) {
	d := c.d
	d.mu.Lock()
	defer d.mu.Unlock()
	qn := normalizeSQL(q)
	vals := namedValues(args)
	switch {
	case strings.Contains(qn, "UPDATE TOKENS"):
		stored, hash := asString(vals[0]), asString(vals[1])
		id, prev := asInt64(vals[2]), asString(vals[3])
		if id == d.failTokenID {
			return nil, fmt.Errorf("injected token failure %d", id)
		}
		for i := range d.tokens {
			if d.tokens[i].id == id && d.tokens[i].apiKey == prev {
				d.tokens[i].apiKey = stored
				d.tokens[i].keyHash = hash
				d.tokenUpdates++
				return driver.RowsAffected(1), nil
			}
		}
		return driver.RowsAffected(0), nil
	case strings.Contains(qn, "UPDATE CHANNELS"):
		sealed := asString(vals[0])
		id, prev := asInt64(vals[1]), asString(vals[2])
		if id == d.failChannelID {
			return nil, fmt.Errorf("injected channel failure %d", id)
		}
		for i := range d.channels {
			if d.channels[i].id == id && d.channels[i].apiKey == prev {
				d.channels[i].apiKey = sealed
				d.channelUpdates++
				return driver.RowsAffected(1), nil
			}
		}
		return driver.RowsAffected(0), nil
	default:
		return nil, fmt.Errorf("unexpected exec: %s", q)
	}
}

type keyMigrateRows struct {
	columns []string
	values  [][]driver.Value
}

func (r *keyMigrateRows) Columns() []string { return r.columns }
func (r *keyMigrateRows) Close() error      { return nil }
func (r *keyMigrateRows) Next(dest []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(dest, r.values[0])
	r.values = r.values[1:]
	return nil
}

var keyMigrateSeq atomic.Uint64

func useKeyMigrateDB(t *testing.T, d *keyMigrateDriver) {
	t.Helper()
	name := fmt.Sprintf("keystore-migrate-%d", keyMigrateSeq.Add(1))
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
}

func captureKeystoreLogs(t *testing.T) *[]string {
	t.Helper()
	var lines []string
	orig := keystoreLogf
	keystoreLogf = func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}
	t.Cleanup(func() { keystoreLogf = orig })
	return &lines
}

func logHas(lines []string, want string) bool {
	for _, line := range lines {
		if strings.Contains(line, want) {
			return true
		}
	}
	return false
}

// gatewayAcceptsKey 与 handlers.authenticateAPIKey 的 WHERE 同义：
// 摘要命中，或尚未迁移时明文相等。
func gatewayAcceptsKey(apiKey, keyHash, presented string) bool {
	if strings.TrimSpace(keyHash) == TokenKeyHash(presented) {
		return true
	}
	return strings.TrimSpace(keyHash) == "" && apiKey == presented
}

func TestMigratePlaintextSecretsIdempotentAndLookup(t *testing.T) {
	SetJWTSecret("keystore-migrate-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	userPlain := "sk-" + strings.Repeat("aa", 16)
	spacedPlain := "sk-" + strings.Repeat("bb", 16)
	healthyPlain := "sk-" + strings.Repeat("cc", 16)
	hashlessPlain := "sk-" + strings.Repeat("dd", 16)
	wrappedPlain := "sk-" + strings.Repeat("ee", 16)
	channelPlain := "sk-channel-live"
	mixedPlain := "sk-channel-later"
	keptPlain := "sk-channel-kept"

	healthyStored, healthyHash, err := SealTokenKey(healthyPlain)
	if err != nil {
		t.Fatal(err)
	}
	hashlessStored, _, err := SealTokenKey(hashlessPlain)
	if err != nil {
		t.Fatal(err)
	}
	inner, err := cryptoutil.Encrypt(JWTSecret(), wrappedPlain)
	if err != nil {
		t.Fatal(err)
	}
	outer, err := cryptoutil.Encrypt(JWTSecret(), inner)
	if err != nil {
		t.Fatal(err)
	}
	kept, err := cryptoutil.Encrypt(JWTSecret(), keptPlain)
	if err != nil {
		t.Fatal(err)
	}
	marker := DeviceCredentialMarker("kiro", 9)

	drv := &keyMigrateDriver{
		tokens: []migrateTokenRow{
			{id: 1, apiKey: userPlain},
			{id: 2, apiKey: healthyStored, keyHash: healthyHash},
			{id: 3, apiKey: hashlessStored, keyHash: ""},
			{id: 4, apiKey: "  " + spacedPlain},
			{id: 5, apiKey: outer, keyHash: TokenKeyHash(inner)},
			{id: 6, apiKey: " " + healthyStored, keyHash: healthyHash},
		},
		channels: []migrateChannelRow{
			{id: 10, apiKey: channelPlain},
			{id: 11, apiKey: marker},
			{id: 12, apiKey: marker + "\n" + mixedPlain},
			{id: 13, apiKey: kept + "\n" + mixedPlain},
		},
	}
	useKeyMigrateDB(t, drv)
	lines := captureKeystoreLogs(t)

	MigratePlaintextSecrets()

	if !logHas(*lines, "用户密钥迁移: 扫描 6，已迁移 5，跳过 1，失败 0") {
		t.Fatalf("user log = %v", *lines)
	}
	if !logHas(*lines, "渠道密钥迁移: 扫描 4，已迁移 3，跳过 1，失败 0") {
		t.Fatalf("channel log = %v", *lines)
	}
	if drv.tokenUpdates != 5 || drv.channelUpdates != 3 {
		t.Fatalf("updates tokens=%d channels=%d", drv.tokenUpdates, drv.channelUpdates)
	}

	drv.mu.Lock()
	tokens := append([]migrateTokenRow(nil), drv.tokens...)
	channels := append([]migrateChannelRow(nil), drv.channels...)
	drv.mu.Unlock()

	byID := map[int64]migrateTokenRow{}
	for _, row := range tokens {
		byID[row.id] = row
	}
	assertToken := func(id int64, plain string, sameCipher string) {
		t.Helper()
		row := byID[id]
		if !cryptoutil.IsEncrypted(row.apiKey) {
			t.Fatalf("token %d not encrypted: %q", id, row.apiKey)
		}
		if strings.Contains(row.apiKey, plain) {
			t.Fatalf("token %d ciphertext contains plaintext", id)
		}
		opened, err := OpenTokenKey(row.apiKey)
		if err != nil || opened != plain {
			t.Fatalf("token %d open = %q err=%v", id, opened, err)
		}
		if row.keyHash != TokenKeyHash(plain) || !gatewayAcceptsKey(row.apiKey, row.keyHash, plain) {
			t.Fatalf("token %d lookup hash = %q", id, row.keyHash)
		}
		if sameCipher != "" && row.apiKey != sameCipher {
			t.Fatalf("token %d ciphertext changed", id)
		}
	}
	assertToken(1, userPlain, "")
	assertToken(2, healthyPlain, healthyStored)
	assertToken(3, hashlessPlain, hashlessStored)
	assertToken(4, spacedPlain, "")
	assertToken(5, wrappedPlain, "")
	if byID[5].apiKey == outer {
		t.Fatal("double-wrapped token was not unwrapped")
	}
	assertToken(6, healthyPlain, healthyStored)

	byChannel := map[int64]migrateChannelRow{}
	for _, row := range channels {
		byChannel[row.id] = row
	}
	if got := OpenChannelAPIKey(byChannel[10].apiKey); got != channelPlain {
		t.Fatalf("channel 10 open = %q", got)
	}
	if strings.Contains(byChannel[10].apiKey, channelPlain) {
		t.Fatal("channel secret stored in plaintext")
	}
	if byChannel[11].apiKey != marker {
		t.Fatalf("marker rewritten: %q", byChannel[11].apiKey)
	}
	if got := OpenChannelAPIKey(byChannel[12].apiKey); got != marker+"\n"+mixedPlain {
		t.Fatalf("channel 12 open = %q", got)
	}
	if !strings.Contains(byChannel[12].apiKey, marker) || strings.Contains(byChannel[12].apiKey, mixedPlain) {
		t.Fatalf("channel 12 stored = %q", byChannel[12].apiKey)
	}
	if got := OpenChannelAPIKey(byChannel[13].apiKey); got != keptPlain+"\n"+mixedPlain {
		t.Fatalf("channel 13 open = %q", got)
	}
	if !strings.HasPrefix(byChannel[13].apiKey, kept+"\n") || strings.Contains(byChannel[13].apiKey, mixedPlain) {
		t.Fatalf("channel 13 stored = %q", byChannel[13].apiKey)
	}

	snapTokens := append([]migrateTokenRow(nil), tokens...)
	snapChannels := append([]migrateChannelRow(nil), channels...)
	*lines = nil
	MigratePlaintextSecrets()

	if !logHas(*lines, "用户密钥迁移: 扫描 6，已迁移 0，跳过 6，失败 0") {
		t.Fatalf("second user log = %v", *lines)
	}
	if !logHas(*lines, "渠道密钥迁移: 扫描 4，已迁移 0，跳过 4，失败 0") {
		t.Fatalf("second channel log = %v", *lines)
	}
	if drv.tokenUpdates != 5 || drv.channelUpdates != 3 {
		t.Fatalf("second run wrote again: tokens=%d channels=%d", drv.tokenUpdates, drv.channelUpdates)
	}
	drv.mu.Lock()
	defer drv.mu.Unlock()
	if fmt.Sprint(drv.tokens) != fmt.Sprint(snapTokens) || fmt.Sprint(drv.channels) != fmt.Sprint(snapChannels) {
		t.Fatal("second run changed stored rows")
	}
}

func TestMigratePlaintextSecretsPartialFailure(t *testing.T) {
	SetJWTSecret("keystore-migrate-secret")
	t.Cleanup(func() { SetJWTSecret("") })

	plainA := "sk-" + strings.Repeat("ab", 16)
	plainB := "sk-" + strings.Repeat("cd", 16)
	plainC := "sk-" + strings.Repeat("ef", 16)
	channelA := "sk-channel-a"
	channelB := "sk-channel-b"

	drv := &keyMigrateDriver{
		tokens: []migrateTokenRow{
			{id: 1, apiKey: plainA},
			{id: 2, apiKey: plainB},
			{id: 3, apiKey: plainC},
		},
		channels: []migrateChannelRow{
			{id: 10, apiKey: channelA},
			{id: 11, apiKey: channelB},
		},
		failTokenID:   2,
		failChannelID: 11,
	}
	useKeyMigrateDB(t, drv)
	lines := captureKeystoreLogs(t)

	MigratePlaintextSecrets()

	if !logHas(*lines, "用户密钥迁移: 扫描 3，已迁移 2，跳过 0，失败 1") {
		t.Fatalf("user log = %v", *lines)
	}
	if !logHas(*lines, "渠道密钥迁移: 扫描 2，已迁移 1，跳过 0，失败 1") {
		t.Fatalf("channel log = %v", *lines)
	}

	drv.mu.Lock()
	var failedToken migrateTokenRow
	var failedChannel migrateChannelRow
	for _, row := range drv.tokens {
		switch row.id {
		case 2:
			failedToken = row
		default:
			opened, err := OpenTokenKey(row.apiKey)
			want := plainA
			if row.id == 3 {
				want = plainC
			}
			if err != nil || opened != want || !gatewayAcceptsKey(row.apiKey, row.keyHash, want) {
				t.Errorf("token %d not migrated for lookup: stored hash %q err=%v", row.id, row.keyHash, err)
			}
		}
	}
	for _, row := range drv.channels {
		if row.id == 11 {
			failedChannel = row
			continue
		}
		if OpenChannelAPIKey(row.apiKey) != channelA || strings.Contains(row.apiKey, channelA) {
			t.Errorf("channel 10 stored = %q", row.apiKey)
		}
	}
	drv.mu.Unlock()

	if failedToken.apiKey != plainB || failedToken.keyHash != "" {
		t.Fatalf("failed token was modified: %+v", failedToken)
	}
	if !gatewayAcceptsKey(failedToken.apiKey, failedToken.keyHash, plainB) {
		t.Fatal("failed plaintext token no longer matches gateway lookup")
	}
	if failedChannel.apiKey != channelB || OpenChannelAPIKey(failedChannel.apiKey) != channelB {
		t.Fatalf("failed channel was modified: %+v", failedChannel)
	}

	drv.mu.Lock()
	drv.failTokenID = 0
	drv.failChannelID = 0
	drv.mu.Unlock()
	*lines = nil
	MigratePlaintextSecrets()

	if !logHas(*lines, "用户密钥迁移: 扫描 3，已迁移 1，跳过 2，失败 0") {
		t.Fatalf("retry user log = %v", *lines)
	}
	if !logHas(*lines, "渠道密钥迁移: 扫描 2，已迁移 1，跳过 1，失败 0") {
		t.Fatalf("retry channel log = %v", *lines)
	}
	drv.mu.Lock()
	defer drv.mu.Unlock()
	for _, row := range drv.tokens {
		want := plainA
		if row.id == 2 {
			want = plainB
		}
		if row.id == 3 {
			want = plainC
		}
		opened, err := OpenTokenKey(row.apiKey)
		if err != nil || opened != want || !gatewayAcceptsKey(row.apiKey, row.keyHash, want) {
			t.Fatalf("token %d after retry open=%q hash=%q err=%v", row.id, opened, row.keyHash, err)
		}
	}
	for _, row := range drv.channels {
		want := channelA
		if row.id == 11 {
			want = channelB
		}
		if OpenChannelAPIKey(row.apiKey) != want || strings.Contains(row.apiKey, want) {
			t.Fatalf("channel %d after retry = %q", row.id, row.apiKey)
		}
	}
}
