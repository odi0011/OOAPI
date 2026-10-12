package services

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"ooapi/internal/db"
	"ooapi/internal/mailer"
)

var (
	ErrEmailCodeDisabled = errors.New("本站未开启邮箱验证码登录")
	ErrCodeRateLimited   = errors.New("发送过于频繁，请稍后再试")
	ErrCodeInvalid       = errors.New("验证码不正确或已过期")
	ErrCodeTooManyTries  = errors.New("尝试次数过多，请重新获取验证码")
	ErrEmailRequired     = errors.New("请填写邮箱")
)

const (
	// 验证码有效期。太短用户体验差，太长则爆破窗口变大。
	codeTTL = 10 * time.Minute

	// 同一邮箱的发码间隔与每日上限，防止被当成短信轰炸器使用。
	codeResendInterval = 60 * time.Second
	codeDailyLimit     = 10

	// 单个验证码最多允许试错次数。6 位数字共 100 万种组合，
	// 5 次上限把暴力猜解的成功率压到可忽略。
	codeMaxAttempts = 5
)

// SendLoginCode 生成验证码并通过邮件发送。
//
// 安全要点：
//   - 验证码只存 bcrypt 哈希，数据库泄露也无法直接使用
//   - 同邮箱有发送间隔与每日上限，避免接口被用来刷邮件
//   - 无论邮箱是否已注册都返回成功，防止被用来探测哪些邮箱注册过
func SendLoginCode(email, ip string) error {
	cfg, ok := GetSMTPConfig()
	if !ok {
		return ErrEmailCodeDisabled
	}

	email = normalizeEmail(email)
	if email == "" {
		return ErrEmailRequired
	}

	if err := checkSendLimits(email); err != nil {
		return err
	}

	code, err := randomCode(6)
	if err != nil {
		return fmt.Errorf("生成验证码: %w", err)
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(code), 10)
	if err != nil {
		return fmt.Errorf("生成验证码哈希: %w", err)
	}

	// 旧码立即失效：同一邮箱同一用途只保留最新一个有效码，
	// 否则历史上的验证码在有效期内都能用，等于放宽了爆破面。
	if _, err := db.DB.Exec(
		"UPDATE email_codes SET consumed_at = NOW() WHERE email = ? AND purpose = 'login' AND consumed_at IS NULL",
		email,
	); err != nil {
		log.Printf("[emailcode] 作废旧码失败: %v", err)
	}

	if _, err := db.DB.Exec(
		`INSERT INTO email_codes (email, code_hash, purpose, expires_at, ip)
		 VALUES (?, ?, 'login', DATE_ADD(NOW(), INTERVAL ? SECOND), ?)`,
		email, string(hash), int(codeTTL.Seconds()), ip,
	); err != nil {
		return fmt.Errorf("保存验证码: %w", err)
	}

	siteName := GetOption("system_name", "OOAPI")
	body := buildCodeEmailBody(siteName, code)

	if err := mailer.Send(mailer.Config{
		Host:     cfg.Host,
		Port:     cfg.Port,
		Username: cfg.Username,
		Password: cfg.Password,
		From:     cfg.From,
		FromName: cfg.FromName,
		UseTLS:   cfg.UseTLS,
	}, mailer.Message{
		To:      email,
		Subject: siteName + " 登录验证码",
		Body:    body,
	}); err != nil {
		// 发信失败要把刚写入的码废掉，否则用户没收到码却要等 60 秒才能重发。
		if _, delErr := db.DB.Exec(
			"UPDATE email_codes SET consumed_at = NOW() WHERE email = ? AND consumed_at IS NULL",
			email,
		); delErr != nil {
			log.Printf("[emailcode] 发送失败后作废验证码出错: %v", delErr)
		}
		return fmt.Errorf("邮件发送失败: %w", err)
	}

	return nil
}

// VerifyLoginCode 校验验证码。
// 校验通过后立即标记为已消费，防止同一个码被重复使用。
func VerifyLoginCode(email, code string) error {
	email = normalizeEmail(email)
	code = strings.TrimSpace(code)
	if email == "" || code == "" {
		return ErrCodeInvalid
	}

	var (
		id       int64
		hash     string
		attempts int
	)
	err := db.DB.QueryRow(
		`SELECT id, code_hash, attempts FROM email_codes
		 WHERE email = ? AND purpose = 'login' AND consumed_at IS NULL AND expires_at > NOW()
		 ORDER BY id DESC LIMIT 1`,
		email,
	).Scan(&id, &hash, &attempts)

	if err != nil {
		return ErrCodeInvalid
	}

	if attempts >= codeMaxAttempts {
		return ErrCodeTooManyTries
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(code)) != nil {
		// 记一次失败尝试。达到上限后即便码正确也会被拒，需重新获取。
		if _, err := db.DB.Exec("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?", id); err != nil {
			log.Printf("[emailcode] 累加尝试次数失败: %v", err)
		}
		return ErrCodeInvalid
	}

	if _, err := db.DB.Exec("UPDATE email_codes SET consumed_at = NOW() WHERE id = ?", id); err != nil {
		log.Printf("[emailcode] 标记已消费失败: %v", err)
	}

	return nil
}

// checkSendLimits 检查发送频率。
func checkSendLimits(email string) error {
	// 间隔检查
	var recent int
	if err := db.DB.QueryRow(
		`SELECT COUNT(*) FROM email_codes
		 WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)`,
		email, int(codeResendInterval.Seconds()),
	).Scan(&recent); err != nil {
		return fmt.Errorf("检查发送频率: %w", err)
	}
	if recent > 0 {
		return ErrCodeRateLimited
	}

	// 每日上限
	var today int
	if err := db.DB.QueryRow(
		`SELECT COUNT(*) FROM email_codes
		 WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
		email,
	).Scan(&today); err != nil {
		return fmt.Errorf("检查每日上限: %w", err)
	}
	if today >= codeDailyLimit {
		return ErrCodeRateLimited
	}

	return nil
}

// randomCode 生成指定位数的数字验证码。
// 用 crypto/rand 而非 math/rand：后者可预测，验证码被猜到等于号被盗。
func randomCode(digits int) (string, error) {
	max := big.NewInt(1)
	for i := 0; i < digits; i++ {
		max.Mul(max, big.NewInt(10))
	}
	n, err := rand.Int(rand.Reader, max)
	if err != nil {
		return "", err
	}
	// 左侧补零，保证长度固定（否则 12345 会被当成 5 位）。
	return fmt.Sprintf("%0*d", digits, n.Int64()), nil
}

func normalizeEmail(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func buildCodeEmailBody(siteName, code string) string {
	return strings.Join([]string{
		"你正在登录 " + siteName + "。",
		"",
		"验证码：" + code,
		"",
		"有效期 10 分钟。若不是你本人操作，请忽略此邮件。",
		"",
		"—— " + siteName,
	}, "\n")
}

// TestSMTP 用当前配置发一封测试邮件，供管理端验证配置是否正确。
// 配置类问题（端口错、密码错、被云厂商封 25 端口）只有真发一次才能确认。
func TestSMTP(to string) error {
	cfg, ok := GetSMTPConfig()
	if !ok {
		return errors.New("SMTP 未配置或未启用")
	}
	if strings.TrimSpace(to) == "" {
		return ErrEmailRequired
	}

	siteName := GetOption("system_name", "OOAPI")
	return mailer.Send(mailer.Config{
		Host:     cfg.Host,
		Port:     cfg.Port,
		Username: cfg.Username,
		Password: cfg.Password,
		From:     cfg.From,
		FromName: cfg.FromName,
		UseTLS:   cfg.UseTLS,
	}, mailer.Message{
		To:      normalizeEmail(to),
		Subject: siteName + " SMTP 测试邮件",
		Body: strings.Join([]string{
			"这是一封测试邮件，说明 " + siteName + " 的邮件服务已配置成功。",
			"",
			"收到此邮件即代表验证码登录可以正常使用。",
			"",
			"—— " + siteName,
		}, "\n"),
	})
}
