package services

import (
	"path/filepath"
	"sync"
)

// JWT 密钥由 main 在启动时注入，避免 services 反向依赖 config 造成循环引用。
var (
	jwtSecret   string
	jwtSecretMu sync.RWMutex
)

// 上传目录根路径，同样在启动时注入。
var (
	uploadRoot   string
	uploadRootMu sync.RWMutex
)

// SetJWTSecret 在启动阶段调用一次。
func SetJWTSecret(s string) {
	jwtSecretMu.Lock()
	jwtSecret = s
	jwtSecretMu.Unlock()
}

// JWTSecret 供签发与校验令牌使用。
func JWTSecret() string {
	jwtSecretMu.RLock()
	defer jwtSecretMu.RUnlock()
	return jwtSecret
}

// SetUploadRoot 在启动阶段注入上传目录。
func SetUploadRoot(dir string) {
	uploadRootMu.Lock()
	uploadRoot = dir
	uploadRootMu.Unlock()
}

// UploadRoot 返回上传目录的绝对路径。
// 放在前端构建产物之外 —— 前端每次构建会清空 web/，上传的文件不能被连带删掉。
func UploadRoot() string {
	uploadRootMu.RLock()
	defer uploadRootMu.RUnlock()
	if uploadRoot == "" {
		return "uploads"
	}
	return uploadRoot
}

// JoinUpload 拼出上传目录下的子路径。
func JoinUpload(elem ...string) string {
	return filepath.Join(append([]string{UploadRoot()}, elem...)...)
}
