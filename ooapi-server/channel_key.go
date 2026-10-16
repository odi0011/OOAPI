package main

/*
channel-key 子命令：打印第一个启用中的 opencode 渠道的 API Key 明文。

**用途**：部署脚本把该 key 写入本机 opencode serve（PUT /auth/opencode）。
serve 需要明文 key 才能代网关调用上游，而网关的渠道表里存的是加密串。

**形态**：`ooapi-server-bin channel-key` —— 无参数，只读，打印一行明文到
stdout（部署脚本用命令替换接收），其余诊断走 stderr。

**为什么不做成 HTTP 接口**：这会成为一条「从网络上读取任意渠道凭据」的
路径，即使加了管理员鉴权也多一个高危面。部署脚本在服务器本地执行，
进程级访问已经是最高权限，不需要再开网络入口。

**输出为空**（退出码 0）：没有启用中的 opencode 渠道，或密钥解不开。
调用方（部署脚本）据此打印手工写入指引，不当成致命错误 ——
没有 opencode 渠道时桥接本来就不需要 key。
*/

import (
	"fmt"
	"os"

	"ooapi/internal/config"
	"ooapi/internal/db"
	"ooapi/internal/services"
)

// runChannelKeyCommand 处理 `channel-key` 子命令；不是该命令时返回 false。
func runChannelKeyCommand(args []string, cfg *config.Config) bool {
	if len(args) == 0 || args[0] != "channel-key" {
		return false
	}
	services.SetJWTSecret(cfg.JWTSecret)
	if err := db.Init(cfg); err != nil {
		fmt.Fprintln(os.Stderr, "初始化数据库失败:", err)
		return true
	}

	// 多个 opencode 渠道时取 id 最小的那个：它们通常指向同一把 key
	// （同一账号的多个用途），任取一个即可。
	var encrypted string
	err := db.DB.QueryRow(`
		SELECT api_key FROM channels
		WHERE LOWER(vendor) = 'opencode' AND status = 1
		ORDER BY id LIMIT 1`).Scan(&encrypted)
	if err != nil {
		fmt.Fprintln(os.Stderr, "查询 opencode 渠道失败:", err)
		return true
	}

	plain := services.OpenChannelAPIKey(encrypted)
	if plain == "" {
		fmt.Fprintln(os.Stderr, "渠道密钥为空或解密失败")
		return true
	}
	// 只输出明文本身（不带换行以外的任何东西），供调用方直接使用。
	fmt.Print(plain)
	return true
}
