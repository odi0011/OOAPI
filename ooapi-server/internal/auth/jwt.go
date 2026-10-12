package auth

import (
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Claims 是签发的令牌内容。
// 权限判定始终以数据库为准，这里的 role 只用于快速拒绝，
// 避免用户被降级后旧令牌仍能访问管理接口。
type Claims struct {
	UserID   int64  `json:"uid"`
	Username string `json:"usr"`
	Role     int    `json:"rol"`
	jwt.RegisteredClaims
}

const (
	AccessTokenTTL  = 24 * time.Hour
	RefreshTokenTTL = 30 * 24 * time.Hour
)

var (
	ErrTokenInvalid = errors.New("令牌无效")
	ErrTokenExpired = errors.New("令牌已过期")
)

// Issue 签发访问令牌。
func Issue(secret string, userID int64, username string, role int) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID:   userID,
		Username: username,
		Role:     role,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "ooapi",
			Subject:   strconv.FormatInt(userID, 10),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(AccessTokenTTL)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString([]byte(secret))
	if err != nil {
		return "", fmt.Errorf("签发令牌: %w", err)
	}
	return signed, nil
}

// Parse 校验并解析令牌。
// 必须限定签名算法：否则攻击者可用 none 算法或改用非对称算法绕过校验。
func Parse(secret, raw string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("非预期的签名算法: %v", t.Header["alg"])
		}
		return []byte(secret), nil
	}, jwt.WithIssuer("ooapi"))

	if err != nil {
		if errors.Is(err, jwt.ErrTokenExpired) {
			return nil, ErrTokenExpired
		}
		return nil, ErrTokenInvalid
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, ErrTokenInvalid
	}
	return claims, nil
}
