package db

// schemaStatements 是全部建表语句，按依赖顺序排列。
// 注意：线上 MySQL 5.7 需使用 utf8mb4_unicode_ci，不能写 8.0 才有的 utf8mb4_0900_ai_ci。
var schemaStatements = []string{
	`CREATE TABLE IF NOT EXISTS users (
		id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		username      VARCHAR(64)     NOT NULL,
		display_name  VARCHAR(64)     NOT NULL DEFAULT '',
		password_hash VARCHAR(255)    NOT NULL DEFAULT '',
		email         VARCHAR(128)    NOT NULL DEFAULT '',
		role          INT             NOT NULL DEFAULT 1,
		status        TINYINT         NOT NULL DEFAULT 1,
		quota         BIGINT          NOT NULL DEFAULT 0,
		used_quota    BIGINT          NOT NULL DEFAULT 0,
		group_name    VARCHAR(64)     NOT NULL DEFAULT 'default',
		invite_code   VARCHAR(32)     NOT NULL DEFAULT '',
		aff_code      VARCHAR(32)     NOT NULL DEFAULT '',
		aff_count     INT             NOT NULL DEFAULT 0,
		aff_quota     BIGINT          NOT NULL DEFAULT 0,
		created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		last_login_at DATETIME        NULL,
		session_version INT           NOT NULL DEFAULT 0,
		avatar_url    VARCHAR(512)    NOT NULL DEFAULT '',
		avatar_media_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
		bio           VARCHAR(255)    NOT NULL DEFAULT '',
		website       VARCHAR(255)    NOT NULL DEFAULT '',
		location      VARCHAR(64)     NOT NULL DEFAULT '',
		PRIMARY KEY (id),
		UNIQUE KEY uk_username (username),
		KEY idx_status (status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS tokens (
		id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id     BIGINT UNSIGNED NOT NULL,
		name        VARCHAR(64)     NOT NULL DEFAULT '',
		api_key     VARCHAR(191)    NOT NULL,
		key_hash    CHAR(64)        NOT NULL DEFAULT '',
		status      TINYINT         NOT NULL DEFAULT 1,
		quota       BIGINT          NOT NULL DEFAULT -1,
		used_quota  BIGINT          NOT NULL DEFAULT 0,
		group_name  VARCHAR(64)     NOT NULL DEFAULT '',
		models      TEXT            NULL,
		expired_at  DATETIME        NULL,
		created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_api_key (api_key),
		KEY idx_user (user_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
	`CREATE TABLE IF NOT EXISTS channels (
		id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		name          VARCHAR(128)    NOT NULL DEFAULT '',
		vendor        VARCHAR(64)     NOT NULL DEFAULT 'custom',
		base_url      VARCHAR(255)    NOT NULL DEFAULT '',
		api_key       TEXT            NOT NULL,
		method        VARCHAR(32)     NOT NULL DEFAULT 'api',
		auth_credential MEDIUMTEXT    NULL,
		auth_expires_at BIGINT        NOT NULL DEFAULT 0,
		auth_version  BIGINT          NOT NULL DEFAULT 0,
		models        TEXT            NULL,
		group_name    VARCHAR(64)     NOT NULL DEFAULT 'default',
		headers       TEXT            NULL,
		model_paths   TEXT            NULL,
		-- 计费口径（账号级）：auto/full = 输入+输出都计；input_only = 只计输入,
		-- 用于「按上下文长度计费」的订阅账号（生成量不额外收费）。
		context_billing VARCHAR(16)   NOT NULL DEFAULT 'auto',
		-- 命名空间：账号分组标签，管理侧展示；不参与调度与计费。
		namespace     VARCHAR(64)     NOT NULL DEFAULT '',
		-- 管理备注，纯展示。
		remark        VARCHAR(255)    NOT NULL DEFAULT '',
		-- 调用方白名单（逗号分隔的 caller client id，如 "codex,claude-code"）。
		-- 非空时只有匹配的调用方才能用该账号；空 = 不限制。
		require_caller VARCHAR(255)   NOT NULL DEFAULT '',
		-- 账号级出口代理（http/https/socks5）。空 = 直连。
		proxy_url     VARCHAR(255)    NOT NULL DEFAULT '',
		-- TLS 指纹模拟：出站握手模仿某个浏览器/运行时的形状。
		-- 空 = 标准库默认握手（与从前一致）；取值见 services.TLSProfileNames。
		tls_fingerprint VARCHAR(24)   NOT NULL DEFAULT '',
		priority      INT             NOT NULL DEFAULT 0,
		weight        INT             NOT NULL DEFAULT 1,
		-- 账号级限流（0 = 不限）。默认 0 是刻意的：既有账号必须行为不变。
		-- 原参考实现的默认值是 1 / 1200 / 20（保守保护反代账号），
		-- 但本站多数账号是普通 API Key 网关，20 次/分钟会瞬间打垮正常业务。
		concurrency   INT             NOT NULL DEFAULT 0,
		min_gap_ms    INT             NOT NULL DEFAULT 0,
		max_per_min   INT             NOT NULL DEFAULT 0,
		status        TINYINT         NOT NULL DEFAULT 1,
		balance       DECIMAL(20,6)   NOT NULL DEFAULT 0,
		used_quota    BIGINT          NOT NULL DEFAULT 0,
		response_time INT             NOT NULL DEFAULT 0,
		last_test_at  DATETIME        NULL,
		last_error    VARCHAR(512)    NOT NULL DEFAULT '',
		created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_status_priority (status, priority)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS logs (
		id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id       BIGINT UNSIGNED NOT NULL DEFAULT 0,
		token_id      BIGINT UNSIGNED NOT NULL DEFAULT 0,
		channel_id    BIGINT UNSIGNED NOT NULL DEFAULT 0,
		type          TINYINT         NOT NULL DEFAULT 1,
		model         VARCHAR(128)    NOT NULL DEFAULT '',
		requested_model VARCHAR(128)  NOT NULL DEFAULT '',
		upstream_model  VARCHAR(128)  NOT NULL DEFAULT '',
		pricing_model   VARCHAR(128)  NOT NULL DEFAULT '',
		prompt_tokens INT             NOT NULL DEFAULT 0,
		completion_tokens INT         NOT NULL DEFAULT 0,
		cached_tokens INT             NOT NULL DEFAULT 0,
		input_price   DECIMAL(20,6)   NOT NULL DEFAULT 0,
		output_price  DECIMAL(20,6)   NOT NULL DEFAULT 0,
		cached_price  DECIMAL(20,6)   NOT NULL DEFAULT 0,
		group_rate    DECIMAL(10,4)   NOT NULL DEFAULT 0,
		base_quota    BIGINT          NOT NULL DEFAULT 0,
		raw_cost      DECIMAL(20,6)   NOT NULL DEFAULT 0,
		quota         BIGINT          NOT NULL DEFAULT 0,
		latency_ms    INT             NOT NULL DEFAULT 0,
		first_token_ms INT            NOT NULL DEFAULT 0,
		ip            VARCHAR(64)     NOT NULL DEFAULT '',
		user_agent    VARCHAR(512)    NOT NULL DEFAULT '',
		caller_client VARCHAR(32)     NOT NULL DEFAULT '',
		detail        TEXT            NULL,
		input_text    TEXT            NULL,
		prompt_text   TEXT            NULL,
		output_text   TEXT            NULL,
		text_truncated TINYINT        NOT NULL DEFAULT 0,
		created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_user_created (user_id, created_at),
		KEY idx_created (created_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS options (
		key_name   VARCHAR(64)  NOT NULL,
		value      TEXT         NULL,
		updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (key_name)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	`CREATE TABLE IF NOT EXISTS model_prices (
		id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		model          VARCHAR(128)    NOT NULL,
		input_price    DECIMAL(20,6)   NOT NULL DEFAULT 0,
		output_price   DECIMAL(20,6)   NOT NULL DEFAULT 0,
		cached_price   DECIMAL(20,6)   NOT NULL DEFAULT 0,
		-- 长上下文计费档位：JSON 数组，形如
		-- [{"min_input_tokens":200000,"input_price":X,"output_price":Y,"cached_price":Z}]。
		-- NULL/空 = 只有基础价，行为与从前完全一致。
		context_tiers  TEXT            NULL,
		updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_model (model)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 账号分组：控制「计费倍率」与「可用模型白名单」。
	//
	// 每个密钥必须绑定一个分组（已取消无分组的公共池）——
	// 否则「这把 Key 能调哪些模型、按什么倍率计费」将无从判定。
	// models 为空表示不限模型；rate 是计费倍率（1 = 原价）。
	`CREATE TABLE IF NOT EXISTS channel_groups (
		id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		name       VARCHAR(64)     NOT NULL,
		remark     VARCHAR(255)    NOT NULL DEFAULT '',
		rate       DECIMAL(10,4)   NOT NULL DEFAULT 1,
		models     TEXT            NULL,
		created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_group_name (name)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 三方账号绑定。一个用户可绑定多个平台，因此用独立表而不是往 users 加列。
	// provider + provider_user_id 唯一：同一个平台账号只能绑到本站一个用户。
	`CREATE TABLE IF NOT EXISTS user_oauth (
		id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id            BIGINT UNSIGNED NOT NULL,
		provider           VARCHAR(32)     NOT NULL,
		provider_user_id   VARCHAR(191)    NOT NULL,
		provider_username  VARCHAR(128)    NOT NULL DEFAULT '',
		provider_email     VARCHAR(191)    NOT NULL DEFAULT '',
		avatar_url         VARCHAR(512)    NOT NULL DEFAULT '',
		created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_provider_uid (provider, provider_user_id),
		KEY idx_user (user_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 邮箱验证码。只存哈希，不存明文；带尝试次数与过期时间。
	`CREATE TABLE IF NOT EXISTS email_codes (
		id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		email       VARCHAR(191)    NOT NULL,
		code_hash   VARCHAR(255)    NOT NULL,
		purpose     VARCHAR(32)     NOT NULL DEFAULT 'login',
		attempts    INT             NOT NULL DEFAULT 0,
		expires_at  DATETIME        NOT NULL,
		consumed_at DATETIME        NULL,
		ip          VARCHAR(64)     NOT NULL DEFAULT '',
		created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_email_purpose (email, purpose, created_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// OAuth 授权时的 state，用于防 CSRF。
	// 一次性使用，回调时立即删除；过期行由定时清理或惰性删除处理。
	`CREATE TABLE IF NOT EXISTS oauth_states (
		state         VARCHAR(64)   NOT NULL,
		provider      VARCHAR(32)   NOT NULL,
		redirect_to   VARCHAR(255)  NOT NULL DEFAULT '',
		code_verifier VARCHAR(128)  NOT NULL DEFAULT '',
		expires_at    DATETIME      NOT NULL,
		created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (state),
		KEY idx_expires (expires_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 媒体库：内容寻址的文件存储。
	//
	// 物理文件按 sha256 落盘（全局一份），media 一行 = 某用户的某个文件。
	// 唯一键 (user_id, sha256) 让「同一用户重复上传同一内容」只留一行，
	// 命中软删行时复活而不是插新行，避免唯一键冲突。
	// 引用计数由 media_refs 重算得来，删除与回收都先看它 ——
	// 否则会话/帖子里的图片会变成死链。
	`CREATE TABLE IF NOT EXISTS media (
		id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id        BIGINT UNSIGNED NOT NULL DEFAULT 0,
		sha256         CHAR(64)        NOT NULL,
		size           BIGINT          NOT NULL DEFAULT 0,
		mime           VARCHAR(96)     NOT NULL DEFAULT '',
		kind           VARCHAR(16)     NOT NULL DEFAULT 'file',
		ext            VARCHAR(16)     NOT NULL DEFAULT '',
		orig_name      VARCHAR(255)    NOT NULL DEFAULT '',
		source         VARCHAR(24)     NOT NULL DEFAULT 'upload',
		width          INT             NOT NULL DEFAULT 0,
		height         INT             NOT NULL DEFAULT 0,
		ref_count      INT             NOT NULL DEFAULT 0,
		status         TINYINT         NOT NULL DEFAULT 1,
		deleted_at     DATETIME        NULL,
		last_access_at DATETIME        NULL,
		created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_media_owner_sha (user_id, sha256),
		KEY idx_media_user (user_id, status, id),
		KEY idx_media_hash (sha256),
		KEY idx_media_reap (status, deleted_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 引用表：谁在哪个对象（会话消息 / 帖子 / 头像）的哪个位置引用了这个文件。
	// 软删 is_live=0 保留审计线索 —— 事后能追溯「这个文件曾被谁引用过」。
	`CREATE TABLE IF NOT EXISTS media_refs (
		id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		media_id   BIGINT UNSIGNED NOT NULL,
		user_id    BIGINT UNSIGNED NOT NULL,
		ref_type   VARCHAR(24)     NOT NULL,
		ref_id     VARCHAR(64)     NOT NULL,
		slot       VARCHAR(24)     NOT NULL DEFAULT '',
		is_live    TINYINT         NOT NULL DEFAULT 1,
		created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uk_media_ref (media_id, ref_type, ref_id, slot),
		KEY idx_refs_object (ref_type, ref_id, is_live),
		KEY idx_refs_media (media_id, is_live)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 用户自绑的交易所 API Key（v1 只接受币安 USDT 合约）。
	// api_key 与 api_secret 以 AES-GCM 落库（enc:v1:），与用户密钥、渠道密钥同一条路径。
	// status 1 = 可用，0 = 已作废；作废后策略不能再选它。
	`CREATE TABLE IF NOT EXISTS exchange_keys (
		id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id     BIGINT UNSIGNED NOT NULL,
		label       VARCHAR(64)     NOT NULL DEFAULT '',
		exchange    VARCHAR(32)     NOT NULL DEFAULT 'binance_usdm',
		network     VARCHAR(16)     NOT NULL DEFAULT 'testnet',
		api_key     TEXT            NOT NULL,
		api_secret  TEXT            NOT NULL,
		status      TINYINT         NOT NULL DEFAULT 1,
		revoked_at  DATETIME        NULL,
		created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_exchange_keys_user (user_id, status)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 自动交易策略配置。v1 只保存短周期 EMA 的参数，不下单、不计算信号。
	// JSON 字段名与验收表一致。mode=live 允许保存，是否真下单由策略引擎按测网全绿强制。
	// 列默认值：20 倍逐仓、日亏 100（关闭）、暂停余额 0.5、1R = 0.8%。
	// 开仓门槛默认 min_score=3、min_win_rate=0.38、min_trades=10、expectancy_tp_cap_r=4。
	// MODIFY 只改新行的列默认值。已有策略（包括生产 DOGE 策略 2）保持原值，部署后要改就走接口。
	`CREATE TABLE IF NOT EXISTS trading_strategies (
		id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id          BIGINT UNSIGNED NOT NULL,
		symbol           VARCHAR(32)     NOT NULL DEFAULT 'XRPUSDT',
		leverage         INT             NOT NULL DEFAULT 20,
		margin_mode      VARCHAR(16)     NOT NULL DEFAULT 'isolated',
		ema_fast         INT             NOT NULL DEFAULT 9,
		ema_slow         INT             NOT NULL DEFAULT 21,
		timeframe        VARCHAR(8)      NOT NULL DEFAULT '5m',
		stop_r           DECIMAL(12,4)   NOT NULL DEFAULT 1,
		take_profit_r    DECIMAL(12,4)   NOT NULL DEFAULT 1.5,
		daily_loss_pct   DECIMAL(12,4)   NOT NULL DEFAULT 100,
		max_margin_usdt  DECIMAL(20,6)   NOT NULL DEFAULT 1.7,
		exchange_key_id  BIGINT UNSIGNED NOT NULL,
		mode             VARCHAR(16)     NOT NULL DEFAULT 'testnet',
		market           VARCHAR(16)     NOT NULL DEFAULT 'futures',
		entry_mode       VARCHAR(16)     NOT NULL DEFAULT 'cross',
		min_score        INT             NOT NULL DEFAULT 3,
		min_win_rate     DECIMAL(8,4)    NOT NULL DEFAULT 0.3800,
		min_trades       INT             NOT NULL DEFAULT 10,
		max_margin_per_trade_usdt DECIMAL(20,6) NOT NULL DEFAULT 0,
		max_consecutive_losses INT      NOT NULL DEFAULT 0,
		pause_balance_usdt DECIMAL(20,6) NOT NULL DEFAULT 0.5,
		pause_reason     VARCHAR(32)     NOT NULL DEFAULT '',
		pause_entries    TINYINT         NOT NULL DEFAULT 0,
		max_open_positions INT          NOT NULL DEFAULT 0,
		rsi_long_min     DECIMAL(8,2)    NOT NULL DEFAULT 50,
		rsi_long_max     DECIMAL(8,2)    NOT NULL DEFAULT 70,
		rsi_short_min    DECIMAL(8,2)    NOT NULL DEFAULT 30,
		rsi_short_max    DECIMAL(8,2)    NOT NULL DEFAULT 50,
		gamble_mode      TINYINT         NOT NULL DEFAULT 0,
		scalp_tp_pct     DECIMAL(8,6)    NOT NULL DEFAULT 0.003000,
		scalp_sl_pct     DECIMAL(8,6)    NOT NULL DEFAULT 0.003000,
		r_fraction       DECIMAL(16,8)   NOT NULL DEFAULT 0.00800000,
		expectancy_tp_cap_r DECIMAL(12,4) NOT NULL DEFAULT 4,
		taker_fee_rate   DECIMAL(16,8)   NOT NULL DEFAULT 0.00050000,
		maker_fee_rate   DECIMAL(16,8)   NOT NULL DEFAULT 0.00020000,
		expectancy_gate  TINYINT         NOT NULL DEFAULT 1,
		running          TINYINT         NOT NULL DEFAULT 0,
		created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_trading_strategies_user (user_id, updated_at),
		KEY idx_trading_strategies_key (exchange_key_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 每一笔开仓当时的分数、门槛、是否加速，以及该策略配置的回测统计。
	// 进程重启后事件环会空，历史从这张表读回来。
	`CREATE TABLE IF NOT EXISTS trading_entries (
		id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id          BIGINT UNSIGNED NOT NULL,
		strategy_id      BIGINT UNSIGNED NOT NULL,
		symbol           VARCHAR(32)     NOT NULL,
		side             VARCHAR(8)      NOT NULL DEFAULT '',
		score            INT             NOT NULL DEFAULT 0,
		min_score        INT             NOT NULL DEFAULT 0,
		boost            TINYINT         NOT NULL DEFAULT 0,
		forced           TINYINT         NOT NULL DEFAULT 0,
		win_rate         DECIMAL(12,6)   NOT NULL DEFAULT 0,
		trade_count      INT             NOT NULL DEFAULT 0,
		net_r            DECIMAL(20,8)   NOT NULL DEFAULT 0,
		expectancy_r     DECIMAL(20,8)   NOT NULL DEFAULT 0,
		expectancy_usdt  DECIMAL(20,8)   NOT NULL DEFAULT 0,
		one_r_usdt       DECIMAL(20,8)   NOT NULL DEFAULT 0,
		live_expectancy  DECIMAL(20,8)   NOT NULL DEFAULT 0,
		take_profit_dist DECIMAL(20,8)   NOT NULL DEFAULT 0,
		entry_price      DECIMAL(20,8)   NOT NULL DEFAULT 0,
		qty              DECIMAL(20,8)   NOT NULL DEFAULT 0,
		opened_at        DATETIME        NOT NULL,
		exit_price       DECIMAL(20,8)   NOT NULL DEFAULT 0,
		exit_qty         DECIMAL(20,8)   NOT NULL DEFAULT 0,
		realized_usdt    DECIMAL(20,8)   NOT NULL DEFAULT 0,
		exit_reason      VARCHAR(64)     NOT NULL DEFAULT '',
		closed_at        DATETIME        NULL,
		created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_trading_entries_strategy (user_id, strategy_id, opened_at),
		KEY idx_trading_entries_opened (opened_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	// 按币安 orderId 记的开平仓。一张单只一行，均价和手续费来自 userTrades，
	// 资金费来自 income 的 FUNDING_FEE。不把多张单并成一行，也不用标记价。
	`CREATE TABLE IF NOT EXISTS trading_orders (
		id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id       BIGINT UNSIGNED NOT NULL,
		strategy_id   BIGINT UNSIGNED NOT NULL,
		symbol        VARCHAR(32)     NOT NULL,
		order_id      VARCHAR(64)     NOT NULL,
		role          VARCHAR(8)      NOT NULL DEFAULT '',
		side          VARCHAR(8)      NOT NULL DEFAULT '',
		price         DECIMAL(20,8)   NOT NULL DEFAULT 0,
		qty           DECIMAL(20,8)   NOT NULL DEFAULT 0,
		realized_pnl  DECIMAL(20,8)   NOT NULL DEFAULT 0,
		commission    DECIMAL(20,8)   NOT NULL DEFAULT 0,
		funding_fee   DECIMAL(20,8)   NOT NULL DEFAULT 0,
		filled_at     DATETIME        NOT NULL,
		created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		UNIQUE KEY uniq_trading_orders_order (strategy_id, order_id),
		KEY idx_trading_orders_strategy (user_id, strategy_id, filled_at)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	/*
		现货网格配置。

		**和 trading_strategies 分开一张表**，不是给它加一列：
		两者的字段几乎没有交集（网格没有杠杆、没有 EMA、没有止损止盈 R），
		合在一起会让一半的列对另一半永远是空的，而"这一列到底属不属于
		这一行"是排查时最容易出错的地方。

		这里只存**配置**，不存运行时状态。每一格还持有多少这种状态，
		由 trading_grid_fills 的成交历史算出来 —— 单一事实来源，
		重启之后不会有"内存和库谁说了算"的问题。
	*/
	`CREATE TABLE IF NOT EXISTS trading_grids (
		id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id          BIGINT UNSIGNED NOT NULL,
		exchange_key_id  BIGINT UNSIGNED NOT NULL,
		symbol           VARCHAR(32)     NOT NULL DEFAULT 'DOGEUSDT',
		mode             VARCHAR(16)     NOT NULL DEFAULT 'testnet',
		lower_price      DECIMAL(20,10)  NOT NULL DEFAULT 0,
		upper_price      DECIMAL(20,10)  NOT NULL DEFAULT 0,
		levels           INT             NOT NULL DEFAULT 8,
		quote_budget     DECIMAL(20,6)   NOT NULL DEFAULT 0,
		stop_pct         DECIMAL(8,6)    NOT NULL DEFAULT 0.020000,
		fee_rate         DECIMAL(16,8)   NOT NULL DEFAULT 0.00100000,
		running          TINYINT         NOT NULL DEFAULT 0,
		pause_reason     VARCHAR(64)     NOT NULL DEFAULT '',
		created_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		updated_at       DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_trading_grids_user (user_id, updated_at),
		KEY idx_trading_grids_key (exchange_key_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

	/*
		网格成交明细。**这里是网格状态的唯一事实来源。**

		为什么不做成"一个格子一行、记当前持有量"：那样每次成交都要
		去 UPDATE 一行，而成交是交易所结算的、本地只是记账 ——
		一旦漏掉一次（网络抖、进程被杀），那一行就永远错了，
		且没有任何东西能把它纠正回来。存明细则是只追加：
		漏掉一笔可以被下一次对账发现，而且"每一格还持有多少"
		是能从明细重算出来的。

		level_index 为 -1 表示清仓单（止损 / 上沿止盈），它不属于任何一格。
	*/
	`CREATE TABLE IF NOT EXISTS trading_grid_fills (
		id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
		user_id       BIGINT UNSIGNED NOT NULL,
		grid_id       BIGINT UNSIGNED NOT NULL,
		symbol        VARCHAR(32)     NOT NULL DEFAULT '',
		level_index   INT             NOT NULL DEFAULT -1,
		side          VARCHAR(8)      NOT NULL DEFAULT '',
		price         DECIMAL(20,10)  NOT NULL DEFAULT 0,
		qty           DECIMAL(24,10)  NOT NULL DEFAULT 0,
		quote         DECIMAL(20,10)  NOT NULL DEFAULT 0,
		fee_quote     DECIMAL(20,10)  NOT NULL DEFAULT 0,
		realized_usdt DECIMAL(20,10)  NOT NULL DEFAULT 0,
		order_id      VARCHAR(64)     NOT NULL DEFAULT '',
		client_id     VARCHAR(64)     NOT NULL DEFAULT '',
		fill_source   VARCHAR(16)     NOT NULL DEFAULT '',
		filled_at     DATETIME        NOT NULL,
		created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
		PRIMARY KEY (id),
		KEY idx_grid_fills_grid (grid_id, filled_at),
		KEY idx_grid_fills_order (grid_id, order_id)
	) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
}

// columnMigrations 给已存在的表补列。
// 新增字段时这里和上面的建表语句必须同步修改，否则老库永远不会补上该列。
var columnMigrations = map[string][]columnDef{
	"users": {
		{"display_name", "VARCHAR(64) NOT NULL DEFAULT '' AFTER username"},
		{"last_login_at", "DATETIME NULL AFTER updated_at"},
		// 头像：三方登录时从平台带回；纯账号密码用户为空，
		// 前端用姓名首字母兜底。
		{"avatar_url", "VARCHAR(512) NOT NULL DEFAULT '' AFTER last_login_at"},
		// 三方登录建号时没有密码，password_hash 允许为空串；
		// email_verified 用来区分「邮箱已通过验证」与「用户随手填的」。
		{"email_verified", "TINYINT NOT NULL DEFAULT 0 AFTER email"},
		// 自定义头像指向 media 表的一行；0 表示没有自定义头像
		//（前端回退首字母色块，或继续用三方平台带回来的 avatar_url）。
		{"avatar_media_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER avatar_url"},
		// 个人资料扩展字段（个人主页展示，均为空串表示未填）。
		{"bio", "VARCHAR(255) NOT NULL DEFAULT '' AFTER avatar_media_id"},
		{"website", "VARCHAR(255) NOT NULL DEFAULT '' AFTER bio"},
		{"location", "VARCHAR(64) NOT NULL DEFAULT '' AFTER website"},
		// 会话版本：改密与退出登录时加一，使已签发的 JWT 立即失效。
		{"session_version", "INT NOT NULL DEFAULT 0"},
	},
	"tokens": {
		{"key_hash", "CHAR(64) NOT NULL DEFAULT ''"},
		{"group_name", "VARCHAR(64) NOT NULL DEFAULT '' AFTER used_quota"},
		{"models", "TEXT NULL AFTER group_name"},
		// 不限额度与「额度为 0」是两件事：前者跟随账号余额，后者是明确的零额度。
		// 用独立标记区分，避免 0 被误当成无限。
		{"unlimited_quota", "TINYINT NOT NULL DEFAULT 1 AFTER quota"},
		// 上次使用时间，用于判断这个密钥多久没被用过。
		{"accessed_at", "DATETIME NULL AFTER created_at"},
	},
	"channels": {
		{"method", "VARCHAR(32) NOT NULL DEFAULT 'api' AFTER api_key"},
		{"auth_credential", "MEDIUMTEXT NULL AFTER method"},
		{"auth_expires_at", "BIGINT NOT NULL DEFAULT 0 AFTER auth_credential"},
		{"auth_version", "BIGINT NOT NULL DEFAULT 0 AFTER auth_expires_at"},
		{"used_quota", "BIGINT NOT NULL DEFAULT 0 AFTER balance"},
		{"last_error", "VARCHAR(512) NOT NULL DEFAULT '' AFTER last_test_at"},
		// TTFT（首 token 耗时）与总耗时分开记：总耗时把「思考 + 生成全文」都算进去，
		// 思考型模型与长回答会被误判成坏账号，而用户体感是「多久开始出字」。
		{"ttft_ms", "INT NOT NULL DEFAULT 0 AFTER response_time"},
		// 「管理员手动禁用」与「测试失败自动禁用」必须能区分 ——
		// 否则一次测试成功会把管理员手动禁用的账号悄悄复活。
		{"disabled_by", "VARCHAR(16) NOT NULL DEFAULT '' AFTER status"},
		{"status_reason", "VARCHAR(255) NOT NULL DEFAULT '' AFTER disabled_by"},
		// 累计调用次数，用于权重轮询与健康度展示。
		{"used_count", "INT NOT NULL DEFAULT 0 AFTER weight"},
		// 冷却截止时间，到点由调度器自动恢复。
		{"cooldown_until", "DATETIME NULL AFTER last_test_at"},
		// 上游要求的额外请求头（每行一条 "Key: Value"）。
		// 有些上游光有 Authorization 不够：OpenCode Go 必须有 x-opencode-session，
		// Azure 要 api-version，OpenRouter 建议带 HTTP-Referer。
		{"headers", "TEXT NULL AFTER group_name"},
		// 模型 → 上游路径的映射。聚合型上游常在同一 base_url 下
		// 按模型分走不同协议（OpenCode Go 就是），必须能按模型指定路径。
		{"model_paths", "TEXT NULL AFTER headers"},
		// 账号级限流。三者的默认值 0 = 不限，这是与参考实现（1/1200/20）
		// 刻意的差别：既有账号必须保持原有吞吐，只有管理员显式配置才限。
		{"concurrency", "INT NOT NULL DEFAULT 0 AFTER weight"},
		{"min_gap_ms", "INT NOT NULL DEFAULT 0 AFTER concurrency"},
		{"max_per_min", "INT NOT NULL DEFAULT 0 AFTER min_gap_ms"},
		// 计费口径：auto（默认，与旧行为一致）、full、input_only。
		{"context_billing", "VARCHAR(16) NOT NULL DEFAULT 'auto' AFTER model_paths"},
		// 命名空间：账号分组标签（管理侧展示）。
		{"namespace", "VARCHAR(64) NOT NULL DEFAULT '' AFTER context_billing"},
		// 管理备注，纯粹为管理大量账号时做标记。
		{"remark", "VARCHAR(255) NOT NULL DEFAULT '' AFTER namespace"},
		// 调用方白名单：非空时只有列出的 caller client 能使用该账号。
		{"require_caller", "VARCHAR(255) NOT NULL DEFAULT '' AFTER remark"},
		// 账号级出口代理：空 = 直连。
		{"proxy_url", "VARCHAR(255) NOT NULL DEFAULT '' AFTER require_caller"},
		{"tls_fingerprint", "VARCHAR(24) NOT NULL DEFAULT '' AFTER proxy_url"},
		/*
			账号内的「上游模型名 → 真实模型」绑定（JSON 对象）。

			绑定是**账号级**的，不是全局的：同一个 default-model 在
			WorkBuddy 与别的上游是完全不同的模型，做成全局映射会把它们
			混成一回事（早先那版就是全局 model_map，已废弃该用法）。

			语义是「声明身份」而不是「路由别名」：它说的是
			「这个账号的 default-model 其实就是 glm-5.3」。
			效果有三处：调度时把官方名翻成上游名、计费按真实模型的价格、
			分组白名单认它。
		*/
		{"model_bindings", "TEXT NULL AFTER model_paths"},
	},
	"model_prices": {
		// 长上下文计费档位（JSON 数组）。老库补列后为 NULL：
		// 空档位 = 只有基础价，既有计费行为不变。
		{"context_tiers", "TEXT NULL AFTER cached_price"},
	},
	"trading_strategies": {
		// market 是「合约还是现货」这个轴，与 mode（测网/实盘）正交。
		// 老库补列后默认 futures：既有策略的行为一个字节都不变。
		{"market", "VARCHAR(16) NOT NULL DEFAULT 'futures'"},
		// 已有行保持 cross。新策略由接口写成 trend。
		{"entry_mode", "VARCHAR(16) NOT NULL DEFAULT 'cross'"},
		{"min_score", "INT NOT NULL DEFAULT 3"},
		{"min_win_rate", "DECIMAL(8,4) NOT NULL DEFAULT 0.3800"},
		{"min_trades", "INT NOT NULL DEFAULT 10"},
		{"max_margin_per_trade_usdt", "DECIMAL(20,6) NOT NULL DEFAULT 0"},
		{"max_consecutive_losses", "INT NOT NULL DEFAULT 0"},
		{"pause_balance_usdt", "DECIMAL(20,6) NOT NULL DEFAULT 0.5"},
		{"pause_reason", "VARCHAR(32) NOT NULL DEFAULT ''"},
		{"pause_entries", "TINYINT NOT NULL DEFAULT 0"},
		{"max_open_positions", "INT NOT NULL DEFAULT 0"},
		{"rsi_long_min", "DECIMAL(8,2) NOT NULL DEFAULT 50"},
		{"rsi_long_max", "DECIMAL(8,2) NOT NULL DEFAULT 70"},
		{"rsi_short_min", "DECIMAL(8,2) NOT NULL DEFAULT 30"},
		{"rsi_short_max", "DECIMAL(8,2) NOT NULL DEFAULT 50"},
		{"gamble_mode", "TINYINT NOT NULL DEFAULT 0"},
		{"scalp_tp_pct", "DECIMAL(8,6) NOT NULL DEFAULT 0.003000"},
		{"scalp_sl_pct", "DECIMAL(8,6) NOT NULL DEFAULT 0.003000"},
		{"r_fraction", "DECIMAL(16,8) NOT NULL DEFAULT 0.00800000"},
		{"expectancy_tp_cap_r", "DECIMAL(12,4) NOT NULL DEFAULT 4"},
		{"taker_fee_rate", "DECIMAL(16,8) NOT NULL DEFAULT 0.00050000"},
		{"maker_fee_rate", "DECIMAL(16,8) NOT NULL DEFAULT 0.00020000"},
		{"expectancy_gate", "TINYINT NOT NULL DEFAULT 1"},
		{"running", "TINYINT NOT NULL DEFAULT 0"},
	},
	"trading_orders": {
		{"user_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0"},
		{"strategy_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0"},
		{"symbol", "VARCHAR(32) NOT NULL DEFAULT ''"},
		{"order_id", "VARCHAR(64) NOT NULL DEFAULT ''"},
		{"role", "VARCHAR(8) NOT NULL DEFAULT ''"},
		{"side", "VARCHAR(8) NOT NULL DEFAULT ''"},
		{"price", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"qty", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"realized_pnl", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"commission", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"funding_fee", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"filled_at", "DATETIME NULL"},
	},
	"trading_entries": {
		{"user_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0"},
		{"strategy_id", "BIGINT UNSIGNED NOT NULL DEFAULT 0"},
		{"symbol", "VARCHAR(32) NOT NULL DEFAULT ''"},
		{"side", "VARCHAR(8) NOT NULL DEFAULT ''"},
		{"score", "INT NOT NULL DEFAULT 0"},
		{"min_score", "INT NOT NULL DEFAULT 0"},
		{"boost", "TINYINT NOT NULL DEFAULT 0"},
		{"forced", "TINYINT NOT NULL DEFAULT 0"},
		{"win_rate", "DECIMAL(12,6) NOT NULL DEFAULT 0"},
		{"trade_count", "INT NOT NULL DEFAULT 0"},
		{"net_r", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"expectancy_r", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"expectancy_usdt", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"one_r_usdt", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"live_expectancy", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"take_profit_dist", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"entry_price", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"qty", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"opened_at", "DATETIME NULL"},
		{"exit_price", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"exit_qty", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"realized_usdt", "DECIMAL(20,8) NOT NULL DEFAULT 0"},
		{"exit_reason", "VARCHAR(64) NOT NULL DEFAULT ''"},
		{"closed_at", "DATETIME NULL"},
	},
	"logs": {
		{"user_agent", "VARCHAR(512) NOT NULL DEFAULT '' AFTER ip"},
		{"caller_client", "VARCHAR(32) NOT NULL DEFAULT '' AFTER user_agent"},
		{"cached_tokens", "INT NOT NULL DEFAULT 0 AFTER completion_tokens"},
		{"detail", "TEXT NULL AFTER ip"},
		// 首字耗时：从请求开始到上游吐出第一个内容增量。
		// 与总耗时分开记录 —— 总耗时把「思考 + 生成全文」都算进去，
		// 思考型模型会被误判成慢账号，而用户体感是「多久开始出字」。
		{"first_token_ms", "INT NOT NULL DEFAULT 0 AFTER latency_ms"},
		// 计费快照：把「按什么名字、什么价、什么倍率、算出多少」随日志固化。
		// 事后价格或倍率被改，历史账单仍能按当时的数字复核。
		// requested/upstream/pricing 三个名字分开记：别名映射（Anthropic 路径）
		// 会让客户端请求的名字与实际发给上游的名字不同。
		{"requested_model", "VARCHAR(128) NOT NULL DEFAULT '' AFTER model"},
		{"upstream_model", "VARCHAR(128) NOT NULL DEFAULT '' AFTER requested_model"},
		{"pricing_model", "VARCHAR(128) NOT NULL DEFAULT '' AFTER upstream_model"},
		{"input_price", "DECIMAL(20,6) NOT NULL DEFAULT 0 AFTER cached_tokens"},
		{"output_price", "DECIMAL(20,6) NOT NULL DEFAULT 0 AFTER input_price"},
		{"cached_price", "DECIMAL(20,6) NOT NULL DEFAULT 0 AFTER output_price"},
		// 0 表示未记录；正常倍率 1 就存 1，不能与「没记录」混为一谈。
		{"group_rate", "DECIMAL(10,4) NOT NULL DEFAULT 0 AFTER cached_price"},
		// 倍率前、向上取整后的额度单位（CalcQuota 的输出）。
		{"base_quota", "BIGINT NOT NULL DEFAULT 0 AFTER group_rate"},
		// 倍率前未取整的额度单位（可含小数），用于对账复核。
		{"raw_cost", "DECIMAL(20,6) NOT NULL DEFAULT 0 AFTER base_quota"},
		// 原文快照：客户端输入（最后一条 user 消息）、上游上下文、模型输出。
		// 一律截断 4000 字符，text_truncated 标记任意一条被截断。
		{"input_text", "TEXT NULL AFTER detail"},
		{"prompt_text", "TEXT NULL AFTER input_text"},
		{"output_text", "TEXT NULL AFTER prompt_text"},
		{"text_truncated", "TINYINT NOT NULL DEFAULT 0 AFTER output_text"},
	},
}
