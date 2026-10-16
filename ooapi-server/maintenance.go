package main

import "ooapi/internal/config"

/*
运维子命令入口。

子命令只在服务器本地执行（部署脚本、排障），不暴露任何网络接口 ——
它们能读到渠道明文凭据，走 HTTP 就意味着多一条「从网络读凭据」的路径。

新增子命令时在这里登记，并在对应文件里实现。
*/

// runMaintenanceCommand 处理运维子命令。返回 true 表示已处理（进程应退出）。
func runMaintenanceCommand(args []string, cfg *config.Config) bool {
	return runChannelKeyCommand(args, cfg)
}
