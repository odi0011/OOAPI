package handlers

/*
日志类型。

logs 表用 TINYINT 区分记录种类，取值集中定义在这里，
避免各处 SQL 里散落魔法数字 —— 看板聚合、日志页筛选、
网关写入三处都要用同一套取值，写岔一个就会静默错算。

注意：前端 AdminLogs 的筛选项与本文件必须同步。
*/
const (
	// LogTypeAdmin 管理操作：改配置、动他人额度这类动作的审计记录。
	LogTypeAdmin = 1
	// LogTypeCall 一次成功的调用，带 token 用量与实际扣费。
	LogTypeCall = 2
	// LogTypeFailed 一次失败的调用：所有候选账号都试过仍没成功。
	// 它没有用量也不扣费，但必须记 —— 否则成功率、失败数无从统计，
	// 用户来问「刚才为什么报错」时也查不到任何痕迹。
	//
	// 这一条只记「请求级」的最终失败（channel_id = 0）：
	// 请求总数按 type IN (2,3) 统计，所以一次请求只会算一次。
	LogTypeFailed = 3

	// LogTypeChannelFail 一次账号尝试失败，但整条请求可能靠换账号成功了。
	//
	// 单独用一类而不是并入 LogTypeFailed：
	// 并入会让「A 失败后 B 成功」的那次请求在全局统计里算成两次，
	// 用户的请求数被凭空放大一倍。
	//
	// 它带着失败的账号 id，是账号成功率的数据来源 —— 账号健康度
	// 必须能看见「这个账号挂过」，否则好坏账号看起来永远都是 100%。
	LogTypeChannelFail = 4

	// LogTypeLogin 一次成功登录（密码、邮箱验证码或第三方）。
	// 与 LogTypeAdmin 一起构成「操作日志」：那是一份行为审计，
	// 回答「谁在什么时候从哪里登了进来」，与用量统计无关。
	LogTypeLogin = 5
)

// callFilter 是「一次请求」的判定条件，成功与失败都算。
// 管理操作不是请求，所以不进这个集合。
const callFilter = "type IN (2, 3)"

// usageFilter 是「使用记录」页面的记录范围：调用成功、请求失败与账号尝试失败。
// 账号尝试失败(4)要留在使用记录里 —— 它是「为什么这次慢/为何换了账号」的解释，
// 但不计入请求总数（见 callFilter）。
const usageFilter = "type IN (2, 3, 4)"

// operationFilter 是「操作日志」页面的记录范围：管理操作与登录。
const operationFilter = "type IN (1, 5)"
