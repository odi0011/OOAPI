package main

import (
	"log"

	"ooapi/internal/config"
	"ooapi/internal/db"
	"ooapi/internal/handlers"
	"ooapi/internal/router"
	"ooapi/internal/services"
)

func main() {
	cfg := config.Load()

	// 先把密钥注入 services，后续所有令牌签发与校验都从这里取。
	services.SetJWTSecret(cfg.JWTSecret)

	// 上传目录放在前端构建产物之外：前端每次构建会清空 web/，
	// 上传的图标若放在里面会被连带删掉。
	services.SetUploadRoot(handlers.UploadRootPath(cfg.WebDir))

	if err := db.Init(cfg); err != nil {
		log.Fatalf("[init] 数据库初始化失败: %v", err)
	}
	defer db.Close()

	if err := services.EnsureDefaultAdmin(cfg.AdminUsername, cfg.AdminPassword); err != nil {
		log.Printf("[init] 初始化管理员失败（不影响启动）: %v", err)
	}
	services.MigratePlaintextSecrets()

	handlers.StartTradingRunner()

	r := router.Setup(cfg)

	addr := "127.0.0.1:" + cfg.Port
	log.Printf("[ooapi] listening on %s", addr)
	if err := r.Run(addr); err != nil {
		log.Fatalf("[ooapi] 服务启动失败: %v", err)
	}
}
