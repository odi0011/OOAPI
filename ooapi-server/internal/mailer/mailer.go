package mailer

import (
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// Config 是一次发信所需的全部参数。
type Config struct {
	Host     string
	Port     int
	Username string
	Password string
	From     string
	FromName string
	// UseTLS 为 true 走直连 TLS（465），否则用 STARTTLS 升级（587/25）。
	UseTLS bool
}

// Message 是一封邮件。
type Message struct {
	To      string
	Subject string
	// Body 为纯文本正文。验证码类邮件不需要 HTML，
	// 纯文本反而更不容易被判定为垃圾邮件。
	Body string
}

// Send 发送一封邮件。
//
// 两种加密方式都要支持：465 端口是「连上即 TLS」，
// 587 端口是「先明文握手再 STARTTLS 升级」，配置写错端口是最常见的失败原因，
// 因此错误信息里会带上实际使用的模式。
func Send(cfg Config, msg Message) error {
	if cfg.Host == "" {
		return errors.New("未配置 SMTP 服务器")
	}
	if msg.To == "" {
		return errors.New("收件人为空")
	}

	from := cfg.From
	if from == "" {
		from = cfg.Username
	}
	if from == "" {
		return errors.New("未配置发件人地址")
	}

	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	payload := buildMessage(cfg, from, msg)

	var client *smtp.Client
	var err error

	if cfg.UseTLS {
		// 直连 TLS：先建 TLS 连接再走 SMTP 协议。
		conn, dialErr := tls.DialWithDialer(
			&net.Dialer{Timeout: 15 * time.Second},
			"tcp", addr,
			&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12},
		)
		if dialErr != nil {
			return fmt.Errorf("连接 %s（TLS 模式）失败: %w", addr, dialErr)
		}
		client, err = smtp.NewClient(conn, cfg.Host)
		if err != nil {
			conn.Close()
			return fmt.Errorf("建立 SMTP 会话失败: %w", err)
		}
	} else {
		client, err = smtp.Dial(addr)
		if err != nil {
			return fmt.Errorf("连接 %s（STARTTLS 模式）失败: %w", addr, err)
		}
		// 有些服务器的证书与主机名不匹配时无法升级，此时明确报错而不是静默降级为明文，
		// 否则会把邮箱密码暴露在网络上。
		if ok, _ := client.Extension("STARTTLS"); ok {
			if err := client.StartTLS(&tls.Config{ServerName: cfg.Host, MinVersion: tls.VersionTLS12}); err != nil {
				client.Close()
				return fmt.Errorf("STARTTLS 升级失败: %w", err)
			}
		} else if cfg.Username != "" {
			client.Close()
			return errors.New("服务器不支持 STARTTLS，为保护密码已中止发送；若服务器要求直连 TLS 请勾选对应选项")
		}
	}
	defer client.Close()

	if cfg.Username != "" {
		auth := smtp.PlainAuth("", cfg.Username, cfg.Password, cfg.Host)
		if ok, _ := client.Extension("AUTH"); ok {
			if err := client.Auth(auth); err != nil {
				return fmt.Errorf("SMTP 认证失败（检查账号密码与授权码）: %w", err)
			}
		}
	}

	if err := client.Mail(from); err != nil {
		return fmt.Errorf("设置发件人失败: %w", err)
	}
	if err := client.Rcpt(msg.To); err != nil {
		return fmt.Errorf("设置收件人失败: %w", err)
	}

	w, err := client.Data()
	if err != nil {
		return fmt.Errorf("开始传输正文失败: %w", err)
	}
	if _, err := w.Write([]byte(payload)); err != nil {
		w.Close()
		return fmt.Errorf("写入正文失败: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("结束传输失败: %w", err)
	}

	return client.Quit()
}

// buildMessage 组装 RFC 5322 邮件。
// Subject 用 UTF-8 编码，否则中文标题在多数客户端会变乱码。
func buildMessage(cfg Config, from string, msg Message) string {
	var b strings.Builder

	fromName := cfg.FromName
	if fromName == "" {
		fromName = "OOAPI"
	}

	b.WriteString("From: ")
	b.WriteString(encodeHeader(fromName))
	b.WriteString(" <")
	b.WriteString(from)
	b.WriteString(">\r\n")

	b.WriteString("To: <")
	b.WriteString(msg.To)
	b.WriteString(">\r\n")

	b.WriteString("Subject: ")
	b.WriteString(encodeHeader(msg.Subject))
	b.WriteString("\r\n")

	b.WriteString("Date: ")
	b.WriteString(time.Now().Format(time.RFC1123Z))
	b.WriteString("\r\n")

	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: text/plain; charset=UTF-8\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n")
	b.WriteString("\r\n")

	// 正文里的裸换行要规范成 CRLF，否则部分客户端会把多行挤成一行。
	body := strings.ReplaceAll(msg.Body, "\r\n", "\n")
	body = strings.ReplaceAll(body, "\n", "\r\n")
	b.WriteString(body)

	return b.String()
}

// encodeHeader 对含非 ASCII 的表头做 RFC 2047 编码。
// 中文主题不编码在多数客户端会显示为乱码。
func encodeHeader(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] > 127 {
			ascii = false
			break
		}
	}
	if ascii {
		return s
	}
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
}
