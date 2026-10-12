package authz

import (
	"errors"
	"strings"
	"unicode"
)

var (
	ErrUsernameTooShort = errors.New("用户名至少 3 个字符")
	ErrUsernameTooLong  = errors.New("用户名最长 32 个字符")
	ErrUsernameCharset  = errors.New("用户名只能包含字母、数字、下划线与连字符")
	ErrPasswordTooShort = errors.New("密码至少 8 位")
	ErrPasswordTooLong  = errors.New("密码最长 128 位")
	ErrPasswordWeak     = errors.New("密码需同时包含字母与数字")
	ErrEmailInvalid     = errors.New("邮箱格式不正确")
)

// NormalizeUsername 统一小写并去除首尾空白。
// 用户名大小写不敏感，避免出现 Admin 与 admin 两个账号。
func NormalizeUsername(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func ValidateUsername(s string) error {
	n := NormalizeUsername(s)
	if len(n) < 3 {
		return ErrUsernameTooShort
	}
	if len(n) > 32 {
		return ErrUsernameTooLong
	}
	for _, r := range n {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' {
			continue
		}
		return ErrUsernameCharset
	}
	return nil
}

// ValidatePassword 要求长度足够且字母数字混合。
// 不强制特殊字符：过于苛刻的规则会促使人们写便签。
func ValidatePassword(s string) error {
	if len(s) < 8 {
		return ErrPasswordTooShort
	}
	if len(s) > 128 {
		return ErrPasswordTooLong
	}

	var hasLetter, hasDigit bool
	for _, r := range s {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
		case unicode.IsDigit(r):
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return ErrPasswordWeak
	}
	return nil
}

// ValidateEmail 做基础格式校验：必须有且仅有一个 @，
// 两侧非空，域名部分含点。不做 RFC 完整校验，那属于过度约束。
func ValidateEmail(s string) error {
	e := strings.TrimSpace(s)
	if e == "" || len(e) > 128 {
		return ErrEmailInvalid
	}
	at := strings.Index(e, "@")
	if at <= 0 || at != strings.LastIndex(e, "@") {
		return ErrEmailInvalid
	}
	local, domain := e[:at], e[at+1:]
	if local == "" || domain == "" {
		return ErrEmailInvalid
	}
	dot := strings.Index(domain, ".")
	if dot <= 0 || dot == len(domain)-1 {
		return ErrEmailInvalid
	}
	if strings.ContainsAny(e, " \t\r\n") {
		return ErrEmailInvalid
	}
	return nil
}
