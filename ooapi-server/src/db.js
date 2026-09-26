import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const host = process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.DB_PORT || 3306);
const user = process.env.DB_USER || "ooapi";
const password = process.env.DB_PASSWORD || "ooapi";
const database = process.env.DB_NAME || "ooapi";

// 弱口令告警：`ooapi` 是文档里的示例口令，不是可以裸奔上线的默认值。
// 不用「直接启动失败」是因为开发/内网环境本就常用它，硬失败会让老部署起不来；
// 但生产环境必须让运维看见（日志 + 启动横幅）。
if (!process.env.DB_PASSWORD && process.env.NODE_ENV === "production") {
  console.error(
    "[db] 警告：未设置 DB_PASSWORD，正在使用示例口令「ooapi」。请在 .env 里改成强口令并同步 MySQL 用户密码。"
  );
}

export const pool = mysql.createPool({
  host,
  port,
  user,
  password,
  database,
  waitForConnections: true,
  // 上游请求常达分钟级，连接会被长时间占用；10 个连接在高并发下容易排队。
  // 可用 DB_POOL_SIZE 覆盖（默认 50）。
  connectionLimit: Math.max(2, Number(process.env.DB_POOL_SIZE) || 50),
  charset: "utf8mb4_unicode_ci",
  timezone: "Z",
});

const TABLES = [
  `CREATE TABLE IF NOT EXISTS model_prices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    model VARCHAR(128) NOT NULL UNIQUE COMMENT '模型 id',
    input_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '输入价格 OD币/百万token',
    output_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '输出价格 OD币/百万token',
    cache_price DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT '缓存命中价格 OD币/百万token（高峰档）',
    /* 分时（峰谷）定价：只有部分厂商按钟点差异定价（DeepSeek 官方工作日 9-12、14-18 为高峰，
       其余时段半价）。NULL = 不启用闲时价，行为与改造前完全一致（全时段按上面的价格）。
       之所以显式存闲时价而不是存折扣率：各家折扣不同（DeepSeek 半价、百炼/方舟窗口也不同），
       存结果价最直观，也便于管理员单独调某一档。 */
    offpeak_input_price DECIMAL(14,6) DEFAULT NULL COMMENT '闲时输入价格 OD币/百万token',
    offpeak_output_price DECIMAL(14,6) DEFAULT NULL COMMENT '闲时输出价格 OD币/百万token',
    offpeak_cache_price DECIMAL(14,6) DEFAULT NULL COMMENT '闲时缓存命中价格 OD币/百万token',
    offpeak_rule TEXT COMMENT '闲时规则 JSON：{"offset":8,"days":[1,2,3,4,5],"peak":[["09:00","12:00"]]}（offset=相对 UTC 小时偏移；peak 窗口之外为空闲）',
    channel_type VARCHAR(32) NOT NULL DEFAULT '' COMMENT '典型渠道类型',
    remark VARCHAR(255) NOT NULL DEFAULT '' COMMENT '价格来源说明',
    updated_time BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password VARCHAR(128) NOT NULL,
    display_name VARCHAR(64) DEFAULT '',
    email VARCHAR(128) DEFAULT '',
    role INT NOT NULL DEFAULT 1 COMMENT '1=普通用户 100=管理员',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用',
    quota BIGINT NOT NULL DEFAULT 0,
    used_quota BIGINT NOT NULL DEFAULT 0,
    request_count INT NOT NULL DEFAULT 0,
    aff_code VARCHAR(32) UNIQUE,
    inviter_id INT NOT NULL DEFAULT 0,
    group_name VARCHAR(32) NOT NULL DEFAULT '',
    setting TEXT,
    created_time BIGINT NOT NULL DEFAULT 0,
    last_login_time BIGINT NOT NULL DEFAULT 0,
    last_login_ip VARCHAR(64) DEFAULT '',
    login_count INT NOT NULL DEFAULT 0,
    -- JWT 吊销版本：改密 +1，旧令牌立即失效（中间件每次请求比对）
    token_version INT NOT NULL DEFAULT 0,
    -- 媒体库引入后的用户资料字段
    avatar_media_id BIGINT NOT NULL DEFAULT 0 COMMENT '头像的 media.id（0=无头像，前端回退首字母色块）',
    bio VARCHAR(255) NOT NULL DEFAULT '' COMMENT '个人简介',
    website VARCHAR(255) NOT NULL DEFAULT '' COMMENT '个人主页/链接',
    location VARCHAR(64) NOT NULL DEFAULT '' COMMENT '所在地'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(64) NOT NULL DEFAULT '',
    key_str VARCHAR(64) NOT NULL UNIQUE COMMENT 'sk-xxxx 格式的 API Key',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用 3=过期',
    created_time BIGINT NOT NULL DEFAULT 0,
    accessed_time BIGINT NOT NULL DEFAULT 0,
    expired_time BIGINT NOT NULL DEFAULT -1 COMMENT '-1 表示永不过期',
    remain_quota BIGINT NOT NULL DEFAULT 0,
    unlimited_quota TINYINT NOT NULL DEFAULT 1,
    used_quota BIGINT NOT NULL DEFAULT 0,
    model_limits TEXT,
    group_name VARCHAR(64) DEFAULT '',
    INDEX idx_tokens_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    username VARCHAR(64) DEFAULT '',
    created_at BIGINT NOT NULL DEFAULT 0,
    type INT NOT NULL DEFAULT 2 COMMENT '1=充值 2=消费 3=管理 4=错误 5=登录',
    content TEXT,
    detail TEXT,
    ip VARCHAR(64) DEFAULT '',
    request_id VARCHAR(64) DEFAULT '',
    quota BIGINT NOT NULL DEFAULT 0,
    /* ---- 使用记录明细（消费类日志用；管理/登录类日志留空） ----
       为什么要落成列而不是全塞 detail JSON：使用记录页要按渠道/模型/密钥/分组筛选与排序，
       全表 JSON 解包既慢又没法建索引（本平台日志量按调用数线性增长）。 */
    model VARCHAR(128) NOT NULL DEFAULT '' COMMENT '请求的模型名',
    channel_id INT NOT NULL DEFAULT 0 COMMENT '实际命中的渠道 id（0=未经过渠道，如登录日志）',
    channel_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '渠道名（冗余存储，渠道改名后历史记录仍可读）',
    token_id INT NOT NULL DEFAULT 0 COMMENT '使用的令牌 id',
    token_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '令牌名（同理冗余）',
    group_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '路由分组（计费倍率口径）',
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    cache_tokens INT NOT NULL DEFAULT 0 COMMENT '缓存命中 token（参与缓存价计费）',
    first_token_ms INT NOT NULL DEFAULT 0 COMMENT '首 token 耗时（流式：首个增量到达；非流式：等同总耗时）',
    elapsed_ms INT NOT NULL DEFAULT 0 COMMENT '端到端总耗时',
    user_agent VARCHAR(255) NOT NULL DEFAULT '' COMMENT '原始 UA（设备识别用，仅管理员可见）',
    device VARCHAR(64) NOT NULL DEFAULT '' COMMENT 'UA 解析出的可读设备（如 Chrome 131 · Windows）',
    price_phase VARCHAR(16) NOT NULL DEFAULT '' COMMENT '计费时段：peak/offpeak/flat（分时定价模型用）',
    INDEX idx_logs_user (user_id),
    INDEX idx_logs_created (created_at),
    INDEX idx_logs_user_type_created (user_id, type, created_at),
    INDEX idx_logs_type_created (type, created_at),
    /* 渠道统计与模型筛选都是「type + 时间范围 + channel/model」的组合查询，
       复合索引才吃得下；单列索引在大表上仍需回表过滤。 */
    INDEX idx_logs_channel_type_created (channel_id, type, created_at),
    INDEX idx_logs_model_type (model, type),
    INDEX idx_logs_token_name (token_name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS options (
    key_str VARCHAR(64) PRIMARY KEY,
    value TEXT
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT '',
    type VARCHAR(32) NOT NULL DEFAULT 'openai' COMMENT 'openai/claude/gemini/deepseek/qwen/custom',
    base_url VARCHAR(255) NOT NULL DEFAULT '' COMMENT '上游接口地址',
    api_key TEXT COMMENT '上游密钥（多 Key 用换行分隔）',
    models TEXT COMMENT '支持的模型，逗号分隔',
    group_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '用户分组',
    group_list TEXT COMMENT '所属分组 JSON 数组（一个账号可属多个分组，分组按厂商隔离；列名避开 MySQL 保留字 groups）',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=手动禁用 3=自动禁用',
    priority INT NOT NULL DEFAULT 0 COMMENT '调度优先级，越大越优先',
    weight INT NOT NULL DEFAULT 0 COMMENT '同优先级负载权重',
    response_time INT NOT NULL DEFAULT 0 COMMENT '最近测试耗时 ms（总耗时，含生成）',
    ttft_ms INT NOT NULL DEFAULT 0 COMMENT '最近测试首 Token 耗时 ms（展示与慢渠道判定用）',
    tested_time BIGINT NOT NULL DEFAULT 0 COMMENT '最近测试时间戳',
    other TEXT COMMENT '扩展配置 JSON',
    remark VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注',
    auto_ban TINYINT NOT NULL DEFAULT 1 COMMENT '1=测试失败自动禁用',
    test_model VARCHAR(128) NOT NULL DEFAULT '' COMMENT '测试用模型',
    test_prompt VARCHAR(255) NOT NULL DEFAULT 'hi' COMMENT '测试/定时检测发送的提示词',
    auto_test TINYINT NOT NULL DEFAULT 0 COMMENT '1=定时检测开启',
    auto_test_interval INT NOT NULL DEFAULT 3600 COMMENT '定时检测间隔（秒，60~86400）',
    last_test_time BIGINT NOT NULL DEFAULT 0 COMMENT '最近一次检测（手动/定时）时间戳；生产调用不更新',
    last_error VARCHAR(500) NOT NULL DEFAULT '' COMMENT '最近错误信息',
    used_count INT NOT NULL DEFAULT 0 COMMENT '累计调用次数',
    last_used_time BIGINT NOT NULL DEFAULT 0 COMMENT '最近调用时间',
    recent_calls TEXT COMMENT '最近调用记录 JSON 数组（环形，最多 20 条：{t,ok,ms}）',
    quota TEXT COMMENT '账号额度快照 JSON（订阅/网页版账号的窗口用量）',
    quota_time BIGINT NOT NULL DEFAULT 0 COMMENT '额度快照抓取时间戳',
    created_time BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS deepseek_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT '',
    token TEXT NOT NULL COMMENT 'DeepSeek 网页版登录态 userToken',
    cookies TEXT COMMENT '浏览器 cookies JSON 数组，用于对齐设备指纹',
    status INT NOT NULL DEFAULT 1 COMMENT '1=启用 2=禁用 3=异常(风控隔离/失效)',
    mute_until BIGINT NOT NULL DEFAULT 0 COMMENT '隔离到期时间戳(秒)，0 表示无',
    used_count INT NOT NULL DEFAULT 0,
    last_used_time BIGINT NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_ds_status (status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 对话工作台（opencode 风格）：session 容器 + message（消息体内是 parts JSON 数组）。
  // 拆两张表而不是一张大 JSON：会话列表只读 session（分页/排序快），
  // 消息按 seq 追加写，流式过程中不会被整体重写。
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id VARCHAR(32) NOT NULL PRIMARY KEY COMMENT '会话 id（短随机串）',
    user_id INT NOT NULL,
    title VARCHAR(120) NOT NULL DEFAULT '',
    agent VARCHAR(32) NOT NULL DEFAULT 'general' COMMENT '智能体 id',
    model VARCHAR(128) NOT NULL DEFAULT '',
    project_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '所属项目（空=未归类）',
    archived TINYINT NOT NULL DEFAULT 0 COMMENT '1=已归档',
    pinned TINYINT NOT NULL DEFAULT 0 COMMENT '1=置顶',
    settings TEXT COMMENT 'JSON：{thinking,search,tools,maxSteps,instructions}',
    todo TEXT COMMENT 'JSON：待办清单（todowrite 工具维护）',
    message_count INT NOT NULL DEFAULT 0,
    cost_units BIGINT NOT NULL DEFAULT 0,
    prompt_tokens BIGINT NOT NULL DEFAULT 0,
    completion_tokens BIGINT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    updated_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_chat_sessions_user (user_id, updated_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 对话项目（ChatGPT 式的「项目」概念）：把会话归档到一个项目下便于分类。
  // 项目只是组织手段，不影响计费与路由；一个会话最多属于一个项目（可随时移出）。
  `CREATE TABLE IF NOT EXISTS chat_projects (
    id VARCHAR(32) NOT NULL PRIMARY KEY COMMENT '项目 id（短随机串）',
    user_id INT NOT NULL,
    name VARCHAR(64) NOT NULL DEFAULT '',
    remark VARCHAR(255) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0,
    updated_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_chat_projects_user (user_id, updated_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id VARCHAR(32) NOT NULL,
    user_id INT NOT NULL,
    seq INT NOT NULL COMMENT '会话内序号，从 1 递增',
    role VARCHAR(16) NOT NULL COMMENT 'user/assistant',
    parts MEDIUMTEXT COMMENT 'JSON 数组：text/reasoning/tool/todo/image/error',
    agent VARCHAR(32) NOT NULL DEFAULT '',
    model VARCHAR(128) NOT NULL DEFAULT '',
    cost DECIMAL(14,6) NOT NULL DEFAULT 0,
    prompt_tokens INT NOT NULL DEFAULT 0,
    completion_tokens INT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_chat_msg_seq (session_id, seq),
    INDEX idx_chat_msg_session (session_id, seq)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 渠道分组：一组渠道的集合，API Key 绑定分组后只路由到组内渠道，并按分组倍率计费。
  //
  // vendor 的语义是「**可选**的厂商筛选」，不是分组的隔离维度：
  //   · 空串 = 不限厂商（分组可跨厂商，例如「便宜档」同时放 deepseek + glm 账号）；
  //   · 有值 = 建组时按该厂商筛了一次渠道（便利），成员仍可后续增删任意厂商的账号。
  // 因此唯一键按 name（分组名全局唯一），不能是 (vendor, name) ——
  // 否则「openai:便宜档」和「glm:便宜档」会变成两个分组，
  // 而用户要的是「一个分组包含多个渠道，或者指定哪个厂商」。
  `CREATE TABLE IF NOT EXISTS channel_groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vendor VARCHAR(32) NOT NULL DEFAULT '' COMMENT '可选的厂商筛选（空=不限厂商，可跨厂商）',
    name VARCHAR(32) NOT NULL COMMENT '分组名（全局唯一）',
    remark VARCHAR(255) NOT NULL DEFAULT '' COMMENT '备注（可为空）',
    rate DECIMAL(10,4) NOT NULL DEFAULT 1 COMMENT '计费倍率',
    models TEXT COMMENT '分组支持的模型 JSON 数组，空=不限',
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_group_name (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 告警规则（运维监控）：字段命名与 sub2api 对齐便于对照，
  // 但增加了 webhook_url / notify_webhook 两个它没有的通道。
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    metric VARCHAR(48) NOT NULL COMMENT '被观测指标（见 services/alert.js METRICS）',
    operator VARCHAR(4) NOT NULL DEFAULT '>' COMMENT '> >= < <= == !=',
    threshold DECIMAL(14,4) NOT NULL DEFAULT 0,
    window_min INT NOT NULL DEFAULT 5 COMMENT '指标统计窗口（分钟）',
    sustained_min INT NOT NULL DEFAULT 5 COMMENT '需连续满足的时长（分钟）',
    cooldown_min INT NOT NULL DEFAULT 30 COMMENT '冷却，避免告警风暴',
    severity VARCHAR(4) NOT NULL DEFAULT 'P2' COMMENT 'P0/P1/P2/P3',
    enabled TINYINT NOT NULL DEFAULT 1,
    notify_email TINYINT NOT NULL DEFAULT 1 COMMENT '1=发邮件',
    notify_webhook TINYINT NOT NULL DEFAULT 1 COMMENT '1=发 Webhook（sub2api 没有）',
    webhook_url VARCHAR(512) NOT NULL DEFAULT '' COMMENT '留空则用系统设置里的默认 Webhook',
    notify_emails VARCHAR(512) NOT NULL DEFAULT '' COMMENT '留空则用系统设置里的默认收件人',
    channels VARCHAR(64) NOT NULL DEFAULT '' COMMENT '启用的通知渠道（email,webhook）',
    filters TEXT COMMENT '作用域 JSON：{channelId, channelType}，空=全局',
    description VARCHAR(255) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 媒体库：一行 = 某用户的某个文件。
  // 物理文件按 sha256 落在 data/media/blobs（两级分片），同一字节全局只存一份 ——
  // 之前对话图片是 base64 直接写进 chat_messages.parts(MEDIUMTEXT)，
  // 3 张图就能超过 16MB 上限（严格模式 INSERT 失败、非严格模式静默截断）。
  `CREATE TABLE IF NOT EXISTS media (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL DEFAULT 0 COMMENT '归属用户（0=系统内置）',
    sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '内容哈希：去重键 + 磁盘寻址键',
    size BIGINT NOT NULL DEFAULT 0,
    mime VARCHAR(96) NOT NULL DEFAULT '' COMMENT '服务端按文件头嗅探，不信任前端',
    kind VARCHAR(16) NOT NULL DEFAULT 'file' COMMENT 'image/file/audio/video/other',
    ext VARCHAR(16) NOT NULL DEFAULT '' COMMENT '规范扩展名（由嗅探结果推导）',
    orig_name VARCHAR(255) NOT NULL DEFAULT '' COMMENT '原始文件名（仅展示/下载，不参与磁盘路径拼接）',
    source VARCHAR(24) NOT NULL DEFAULT '' COMMENT '上传入口：chat/avatar/post/admin',
    width INT NOT NULL DEFAULT 0,
    height INT NOT NULL DEFAULT 0,
    parent_id BIGINT NOT NULL DEFAULT 0 COMMENT '派生来源（裁剪图指向原图；0=原件）',
    ref_count INT NOT NULL DEFAULT 0 COMMENT '有效引用数（media_refs.is_live=1 的条数）',
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已删（待回收） 3=封禁',
    deleted_time BIGINT NOT NULL DEFAULT 0,
    last_access_time BIGINT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    updated_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_media_owner_hash (user_id, sha256),
    KEY idx_media_user_list (user_id, status, id),
    KEY idx_media_user_size (user_id, status, size),
    KEY idx_media_hash (sha256),
    KEY idx_media_reap (status, deleted_time),
    KEY idx_media_kind (user_id, kind, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 媒体引用：谁在用这个文件（删会话/删用户时据此释放，避免孤儿文件与悬空引用）
  `CREATE TABLE IF NOT EXISTS media_refs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    media_id BIGINT NOT NULL,
    user_id INT NOT NULL DEFAULT 0 COMMENT '引用者（权限校验与按用户清理）',
    ref_type VARCHAR(24) NOT NULL COMMENT 'chat_message/avatar/community_post/...',
    ref_id VARCHAR(64) NOT NULL COMMENT '被引用对象 id',
    slot VARCHAR(24) NOT NULL DEFAULT '' COMMENT '同一对象内位置（part id / avatar）',
    is_live TINYINT NOT NULL DEFAULT 1 COMMENT '1=有效 0=已解绑（软删保留审计）',
    created_time BIGINT NOT NULL DEFAULT 0,
    updated_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_media_ref (media_id, ref_type, ref_id, slot),
    KEY idx_refs_object (ref_type, ref_id, is_live),
    KEY idx_refs_media (media_id, is_live),
    KEY idx_refs_user (user_id, ref_type, is_live)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 告警事件：触发时把「当时的指标快照」一起落库，事后可复盘（sub2api 只存事件本身）
  `CREATE TABLE IF NOT EXISTS alert_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    rule_id INT NOT NULL,
    rule_name VARCHAR(64) NOT NULL DEFAULT '',
    severity VARCHAR(4) NOT NULL DEFAULT 'P2',
    metric VARCHAR(48) NOT NULL DEFAULT '',
    value DECIMAL(14,4) NOT NULL DEFAULT 0 COMMENT '触发时的指标值',
    threshold DECIMAL(14,4) NOT NULL DEFAULT 0,
    operator VARCHAR(4) NOT NULL DEFAULT '',
    status VARCHAR(16) NOT NULL DEFAULT 'firing' COMMENT 'firing/resolved',
    detail TEXT COMMENT '触发时的指标快照 JSON',
    resolved_value DECIMAL(14,4) NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    resolved_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_alert_events_time (created_time),
    INDEX idx_alert_events_status (status, created_time),
    INDEX idx_alert_events_rule (rule_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 通知投递日志：告警通道自己也会坏，出问题时得能查到「发了但失败了」
  `CREATE TABLE IF NOT EXISTS alert_notify_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    rule_id INT NOT NULL DEFAULT 0,
    channel VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'email/webhook',
    ok TINYINT NOT NULL DEFAULT 1,
    error VARCHAR(400) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_alert_notify_time (created_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // ---------------------------------------------------------------------------
  // 社区：话题 / 帖子 / 评论 / 互动（点赞收藏）/ 关注
  // ---------------------------------------------------------------------------
  // 话题：发帖必须归入一个话题（不做「无话题」的散帖 —— 社区没有分类会很快变成
  // 信息垃圾场，检索与治理都无从下手）。
  `CREATE TABLE IF NOT EXISTS community_topics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(40) NOT NULL UNIQUE,
    description VARCHAR(160) NOT NULL DEFAULT '',
    icon VARCHAR(16) NOT NULL DEFAULT '' COMMENT 'emoji 或图标名',
    post_count INT NOT NULL DEFAULT 0 COMMENT '冗余计数：列表页按热度排序不查子表',
    sort INT NOT NULL DEFAULT 0 COMMENT '越大越靠前',
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=停用（停用后不再接受新帖，历史帖仍可读）',
    created_time BIGINT NOT NULL DEFAULT 0,
    INDEX idx_topic_sort (status, sort, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS community_posts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    topic_id INT NOT NULL DEFAULT 0,
    title VARCHAR(120) NOT NULL DEFAULT '',
    content MEDIUMTEXT NOT NULL,
    media_ids TEXT COMMENT '附件 media.id 列表（JSON 数组），字节在媒体库',
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favorite_count INT NOT NULL DEFAULT 0,
    view_count INT NOT NULL DEFAULT 0,
    is_pinned TINYINT NOT NULL DEFAULT 0 COMMENT '置顶（管理员）',
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已删 3=隐藏（管理员）',
    -- 治理留痕：谁删的、为什么。社区内容被删必须能回答「谁删的」
    deleted_by INT NOT NULL DEFAULT 0,
    deleted_time BIGINT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    updated_time BIGINT NOT NULL DEFAULT 0,
    KEY idx_post_list (status, is_pinned, id),
    KEY idx_post_topic (topic_id, status, id),
    KEY idx_post_user (user_id, status, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS community_comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    parent_id BIGINT NOT NULL DEFAULT 0 COMMENT '一级评论 id（0=直接评论帖子）。刻意不做无限级：见下方说明',
    reply_to_user_id INT NOT NULL DEFAULT 0 COMMENT '被回复者（扁平化后靠 @ 标明上下文）',
    content TEXT NOT NULL,
    media_ids TEXT COMMENT '附图 media.id 列表（JSON 数组），字节在媒体库；与帖子同一套',
    like_count INT NOT NULL DEFAULT 0,
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已删 3=隐藏',
    deleted_by INT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    KEY idx_comment_post (post_id, status, id),
    KEY idx_comment_user (user_id, status, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  // 评论只允许两层：parent_id 永远指向一级评论。
  // 无限级递归在窄屏会把文字压成细条（每层缩进吃掉宽度），
  // 而开发者习惯引用回复，实际很容易到 4-5 层。做法是「回复二级评论时挂到它的一级父节点，
  // 用 reply_to_user_id 标明@谁」，缩进恒为 1 级。

  // 互动：点赞与收藏合成一张表（kind 区分）。
  // 唯一键保证「同一人同一目标同一动作」只有一条 —— 并发双击也不会重复计数。
  `CREATE TABLE IF NOT EXISTS community_reactions (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    target_type VARCHAR(16) NOT NULL COMMENT 'post/comment',
    target_id BIGINT NOT NULL,
    kind VARCHAR(16) NOT NULL COMMENT 'like/favorite',
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_reaction (user_id, target_type, target_id, kind),
    KEY idx_reaction_target (target_type, target_id, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 通知：社区互动的提醒（评论/回复/点赞/收藏/关注）
  // 为什么落库而不是只用 SSE：SSE 是「现在有人在看」的加速通道，
  // 用户离线时错过的提醒必须以数据库为准（否则关掉页面就永久丢失）。
  `CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL COMMENT '接收者',
    actor_id INT NOT NULL COMMENT '触发者',
    type VARCHAR(24) NOT NULL COMMENT 'post_comment/comment_reply/post_like/comment_like/post_favorite/follow',
    post_id BIGINT NOT NULL DEFAULT 0,
    comment_id BIGINT NOT NULL DEFAULT 0,
    extra VARCHAR(160) NOT NULL DEFAULT '' COMMENT '当时的帖子标题（帖子被删后仍可读）',
    is_read TINYINT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    KEY idx_notify_user (user_id, is_read, id),
    KEY idx_notify_clean (is_read, created_time)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS community_follows (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    follower_id INT NOT NULL COMMENT '关注者',
    followee_id INT NOT NULL COMMENT '被关注者',
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_follow (follower_id, followee_id),
    KEY idx_followee (followee_id, id),
    KEY idx_follower (follower_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // ---------------------------------------------------------------------------
  // 实时聊天：房间 / 成员 / 消息
  // ---------------------------------------------------------------------------
  // 三种房间共用一个表：type 区分 single（单聊）/ group（群聊）/ discussion（讨论组）。
  // 单聊也建成房间而不是「一对用户的消息表」—— 否则拉会话列表要 union 两种结构，
  // 且「从单聊升级成群聊」得搬数据。
  `CREATE TABLE IF NOT EXISTS chat_rooms (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(16) NOT NULL DEFAULT 'group' COMMENT 'single/group/discussion',
    name VARCHAR(64) NOT NULL DEFAULT '',
    owner_id INT NOT NULL DEFAULT 0,
    avatar_media_id BIGINT NOT NULL DEFAULT 0,
    member_count INT NOT NULL DEFAULT 0,
    -- 单聊唯一键：两个用户 id 排序后拼成 "小:大"。
    -- 没有它，A→B 连点两次「发消息」会建出两个房间，双方各看一个、消息永远对不上。
    -- 群聊/讨论组为 NULL（唯一键允许多个 NULL，所以不影响建群）。
    single_key VARCHAR(40) DEFAULT NULL COMMENT '单聊唯一键（群聊为 NULL）',
    -- 冗余最后一条消息：会话列表要按活跃度排序，不能对每个房间查一次消息表
    last_message_id BIGINT NOT NULL DEFAULT 0,
    last_message_text VARCHAR(120) NOT NULL DEFAULT '',
    last_message_time BIGINT NOT NULL DEFAULT 0,
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已解散',
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_room_single (single_key),
    KEY idx_room_active (status, last_message_time),
    KEY idx_room_owner (owner_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS chat_room_members (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'member' COMMENT 'owner/admin/member',
    last_read_id BIGINT NOT NULL DEFAULT 0 COMMENT '已读到哪条消息（未读数据此算）',
    muted TINYINT NOT NULL DEFAULT 0 COMMENT '免打扰',
    joined_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_room_member (room_id, user_id),
    KEY idx_member_user (user_id, room_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS chat_room_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    room_id BIGINT NOT NULL,
    user_id INT NOT NULL,
    type VARCHAR(16) NOT NULL DEFAULT 'text' COMMENT 'text/image/system',
    content TEXT,
    media_ids TEXT COMMENT '图片 media.id 列表（JSON 数组）',
    -- 客户端临时 id：发送方生成，服务端原样回显。
    -- 用途是「乐观队列」—— 消息先本地显示为「发送中」，SSE 广播回来匹配到这个 id
    -- 才置为已发送。没有它就无法区分「我发的这条」与「别人发的」，弱网下会重复插入。
    client_id VARCHAR(40) NOT NULL DEFAULT '',
    created_time BIGINT NOT NULL DEFAULT 0,
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已撤回/删除',
    -- 增量拉取靠 (room_id, id)：客户端带 since_id 只取新消息
    KEY idx_room_msg (room_id, id),
    KEY idx_msg_user (user_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // ---------------------------------------------------------------------------
  // 好友系统：关系列表 / 申请与验证
  // ---------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS friendships (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL COMMENT '用户ID',
    friend_id INT NOT NULL COMMENT '好友ID',
    remark VARCHAR(64) NOT NULL DEFAULT '' COMMENT '好友自定义备注名',
    status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 2=已解除',
    created_time BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uniq_user_friend (user_id, friend_id),
    KEY idx_friend_user (friend_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS friend_requests (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    from_user_id INT NOT NULL COMMENT '申请发起人',
    to_user_id INT NOT NULL COMMENT '接收申请人',
    message VARCHAR(255) NOT NULL DEFAULT '' COMMENT '验证说明留言',
    status TINYINT NOT NULL DEFAULT 0 COMMENT '0=待处理 1=已同意 2=已拒绝',
    handled_time BIGINT NOT NULL DEFAULT 0,
    created_time BIGINT NOT NULL DEFAULT 0,
    KEY idx_to_user (to_user_id, status, id),
    KEY idx_from_user (from_user_id, status, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 频道体系（community_guilds / community_channels）已下线（第 79 批）：
  // 社区帖子承担公共讨论，实时聊天只保留单聊与群聊。新装不再建这两张表；
  // 老库里的表与数据**不删**（只读遗留，回滚代码即可恢复），见 retireGuildRooms。
];

// 生成 / 持久化 JWT 密钥：环境变量 > .jwt-secret 文件 > 随机生成
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // 用「包根目录」而不是 cwd：systemd 与手动 `node src/index.js` 的 cwd 可能不同，
  // 从不同目录启动会在新位置生成新密钥，导致全站登录态失效（表现为「莫名其妙掉登录」）。
  const secretFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".jwt-secret");
  try {
    const s = fs.readFileSync(secretFile, "utf8").trim();
    if (s) return s;
  } catch {
    /* 文件不存在：下面生成 */
  }
  const s = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(secretFile, s, { mode: 0o600 });
  } catch (e) {
    // 写不进去就等于每次重启换密钥（全员掉线），必须让运维看到而不是静默
    console.warn(`[db] JWT 密钥无法写入 ${secretFile}（${e.message}）；本次使用进程内随机密钥，重启后所有登录态会失效`);
  }
  return s;
}

export const JWT_SECRET = resolveJwtSecret();

// 增量列补齐（与 migrate2/3/5.mjs 等价，幂等）——全新安装直接由 db.js 建全，
// 老库启动时自动补列，不再依赖手动跑迁移脚本。
const COLUMN_MIGRATIONS = [
  { table: "users", column: "token_version", ddl: "INT NOT NULL DEFAULT 0" },
  // 社区/聊天（第 37 批）：评论扁平化的 @ 目标 + 消息的客户端临时 id（乐观队列）
  { table: "community_comments", column: "reply_to_user_id", ddl: "INT NOT NULL DEFAULT 0" },
  // 评论附图（2026-09-24）：用户要求「评论也要能带图」。
  // 走列迁移而不是只改建表语句 —— 线上库的表已存在，CREATE TABLE IF NOT EXISTS 不会补列。
  { table: "community_comments", column: "media_ids", ddl: "TEXT" },
  { table: "chat_room_messages", column: "client_id", ddl: "VARCHAR(40) NOT NULL DEFAULT ''" },
  // 单聊唯一键：本次上线时 chat_rooms 已按老建表语句建好（不含此列），
  // CREATE TABLE IF NOT EXISTS 不会补，必须走列迁移。
  // 唯一索引由 ensureIndexes 单独创建（CREATE INDEX 语法不支持 UNIQUE）。
  { table: "chat_rooms", column: "single_key", ddl: "VARCHAR(40) DEFAULT NULL" },
  { table: "chat_rooms", column: "announcement", ddl: "VARCHAR(500) NOT NULL DEFAULT ''" },
  { table: "chat_rooms", column: "guild_channel_id", ddl: "BIGINT NOT NULL DEFAULT 0" },
  // 媒体库 / 用户资料（第 36 批）：头像引用 + 个人简介三件套
  { table: "users", column: "avatar_media_id", ddl: "BIGINT NOT NULL DEFAULT 0" },
  { table: "users", column: "bio", ddl: "VARCHAR(255) NOT NULL DEFAULT ''" },
  { table: "users", column: "website", ddl: "VARCHAR(255) NOT NULL DEFAULT ''" },
  { table: "users", column: "location", ddl: "VARCHAR(64) NOT NULL DEFAULT ''" },
  { table: "channels", column: "last_error", ddl: "VARCHAR(500) NOT NULL DEFAULT ''" },
  // 首 Token 耗时（老库补列）：与 response_time（总耗时）并存，前者用于展示与慢渠道判定
  { table: "channels", column: "ttft_ms", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "channels", column: "used_count", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "channels", column: "last_used_time", ddl: "BIGINT NOT NULL DEFAULT 0" },
  { table: "channels", column: "remark", ddl: "VARCHAR(255) NOT NULL DEFAULT ''" },
  { table: "channels", column: "auto_ban", ddl: "TINYINT NOT NULL DEFAULT 1" },
  { table: "channels", column: "test_model", ddl: "VARCHAR(128) NOT NULL DEFAULT ''" },
  { table: "channels", column: "test_prompt", ddl: "VARCHAR(255) NOT NULL DEFAULT 'hi'" },
  { table: "channels", column: "auto_test", ddl: "TINYINT NOT NULL DEFAULT 0" },
  { table: "channels", column: "auto_test_interval", ddl: "INT NOT NULL DEFAULT 3600" },
  { table: "channels", column: "last_test_time", ddl: "BIGINT NOT NULL DEFAULT 0" },
  { table: "channels", column: "group_list", ddl: "TEXT" },
  { table: "channels", column: "recent_calls", ddl: "TEXT" },
  // 上游 429（限流）的恢复时刻（epoch 秒，0 = 未限流）。
  // 与 status=3 配合表达「临时停用，到点自动恢复」——见 router.markChannelError：
  // status=3 且 rate_limit_until>0 的渠道由后台任务到点自动放回启用；
  // 凭据失效那类自动暂停（rate_limit_until=0）仍要管理员手工处理。
  { table: "channels", column: "rate_limit_until", ddl: "BIGINT NOT NULL DEFAULT 0" },
  // 最后一次失败的错误码：前端据此区分「429 限流」「凭据失效」「风控」并给不同提示。
  // 不能再靠 last_error 的文案正则猜 —— 文案会随适配器改写而漂移。
  { table: "channels", column: "last_error_code", ddl: "VARCHAR(48) NOT NULL DEFAULT ''" },
  // 账号额度快照（订阅/网页版账号的窗口用量）+ 抓取时间；由显式「查额度」或低频定时任务写入
  { table: "channels", column: "quota", ddl: "TEXT" },
  { table: "channels", column: "quota_time", ddl: "BIGINT NOT NULL DEFAULT 0" },
  // 使用记录明细列（老库补列）：日志展示与筛选按列走，不再解 detail JSON
  { table: "logs", column: "model", ddl: "VARCHAR(128) NOT NULL DEFAULT ''" },
  { table: "logs", column: "channel_id", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "channel_name", ddl: "VARCHAR(64) NOT NULL DEFAULT ''" },
  { table: "logs", column: "token_id", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "token_name", ddl: "VARCHAR(64) NOT NULL DEFAULT ''" },
  { table: "logs", column: "group_name", ddl: "VARCHAR(64) NOT NULL DEFAULT ''" },
  { table: "logs", column: "prompt_tokens", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "completion_tokens", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "cache_tokens", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "first_token_ms", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "elapsed_ms", ddl: "INT NOT NULL DEFAULT 0" },
  { table: "logs", column: "user_agent", ddl: "VARCHAR(255) NOT NULL DEFAULT ''" },
  { table: "logs", column: "device", ddl: "VARCHAR(64) NOT NULL DEFAULT ''" },
  { table: "logs", column: "price_phase", ddl: "VARCHAR(16) NOT NULL DEFAULT ''" },
  // 分时定价（DeepSeek 峰谷）：老库补列；NULL = 不启用闲时价，行为与改造前一致
  { table: "model_prices", column: "offpeak_input_price", ddl: "DECIMAL(14,6) DEFAULT NULL" },
  { table: "model_prices", column: "offpeak_output_price", ddl: "DECIMAL(14,6) DEFAULT NULL" },
  { table: "model_prices", column: "offpeak_cache_price", ddl: "DECIMAL(14,6) DEFAULT NULL" },
  { table: "model_prices", column: "offpeak_rule", ddl: "TEXT" },
  { table: "channel_groups", column: "rate", ddl: "DECIMAL(10,4) NOT NULL DEFAULT 1" },
  { table: "channel_groups", column: "models", ddl: "TEXT" },
  { table: "chat_sessions", column: "project_id", ddl: "VARCHAR(32) NOT NULL DEFAULT ''" },
  { table: "chat_sessions", column: "archived", ddl: "TINYINT NOT NULL DEFAULT 0" },
  { table: "chat_sessions", column: "pinned", ddl: "TINYINT NOT NULL DEFAULT 0" },
];

// 列类型扩容（老库）：列宽不足时 ALTER。
// 历史问题：channels.api_key 是 VARCHAR(255)，「多 Key 用换行分隔」约 3 个 Key 就溢出 500。
const TYPE_MIGRATIONS = [
  { table: "channels", column: "api_key", dataType: "text", ddl: "TEXT" },
  // 令牌分组绑定值是 "厂商:分组名"，VARCHAR(32) 装不下长厂商名（如 claude-oauth）
  { table: "tokens", column: "group_name", dataType: "varchar", minLen: 64, ddl: "VARCHAR(64) DEFAULT ''" },
];

async function ensureColumnTypes() {
  for (const m of TYPE_MIGRATIONS) {
    try {
      const [rows] = await pool.query(
        "SELECT data_type AS t, character_maximum_length AS len FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
        [m.table, m.column]
      );
      if (!rows.length) continue;
      const typeChanged = String(rows[0].t).toLowerCase() !== m.dataType;
      const tooShort = m.minLen && Number(rows[0].len || 0) < m.minLen;
      if (typeChanged || tooShort) {
        // 同一连接上限时（与 ensureColumns 同理：pool.query 每次取不同连接）
        const conn = await pool.getConnection();
        try {
          await conn.query("SET SESSION lock_wait_timeout = 20");
          await conn.query(`ALTER TABLE ${m.table} MODIFY ${m.column} ${m.ddl}`);
        } finally {
          conn.release();
        }
        console.log(`[migrate] ${m.table}.${m.column} 已扩容为 ${m.ddl}`);
      }
    } catch (e) {
      // 扩容失败不应阻断启动（下次启动会重试）；缺列型问题由 ensureColumns 覆盖
      console.error(`[migrate] ${m.table}.${m.column} 扩容失败（下次启动会重试）：${e.message}`);
    }
  }
}

async function ensureColumns() {
  // 按表分组：同一张表的多个缺列**合并成一条 ALTER**。
  // 为什么：逐列 ALTER 在 MySQL 5.7 上每一列都要重建一次整表，logs 新增 14 列
  // 就是 14 次全表重建；合并后只重建一次。MySQL 8.0.12+ 对「末尾追加 + 常量默认值」
  // 走 INSTANT（只改数据字典），合并同样只有一条 DDL，代价更低。
  const byTable = new Map();
  for (const m of COLUMN_MIGRATIONS) {
    if (!byTable.has(m.table)) byTable.set(m.table, []);
    byTable.get(m.table).push(m);
  }
  for (const [table, cols] of byTable) {
    const [rows] = await pool
      .query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?", [
        table,
      ])
      .catch(() => [[]]);
    const have = new Set(rows.map((r) => String(r.c).toLowerCase()));
    const missing = cols.filter((m) => !have.has(m.column.toLowerCase()));
    if (!missing.length) continue;

    // 必须在**同一个连接**上 SET SESSION + ALTER：mysql2 的 pool.query 每次独立取连接，
    // 分两条语句发出去时 SET 很可能落在别的连接上（限时不生效），
    // 而这条连接归还后 20s 的 lock_wait_timeout 还会残留给后续无关查询。
    const conn = await pool.getConnection();
    try {
      // 单表 ALTER 限时：大表上可能长时间等 MDL，把启动卡死。
      // 超时/失败都只记日志继续 —— 补列是幂等的，下次启动会重试；
      // 而「因为一列加不上就让服务起不来」（配合 systemd Restart=always 会变成
      // 三秒重启一次的死循环，站点全挂）是更严重的问题。
      await conn.query("SET SESSION lock_wait_timeout = 20");
      const clause = missing.map((m) => `ADD COLUMN ${m.column} ${m.ddl}`).join(", ");
      try {
        await conn.query(`ALTER TABLE ${table} ${clause}`);
        console.log(`[migrate] ${table} 已补齐 ${missing.length} 列：${missing.map((m) => m.column).join(", ")}`);
      } catch (e) {
        // 合并 ALTER 里只要有一列不合法，整条都会失败 → 退化为逐列，
        // 让能加的列先加上（与合并前行为一致，不会因一列坏掉让整表停在半迁移状态）。
        console.warn(`[migrate] ${table} 合并补列失败（${e.message}），改为逐列重试`);
        for (const m of missing) {
          try {
            await conn.query(`ALTER TABLE ${table} ADD COLUMN ${m.column} ${m.ddl}`);
            console.log(`[migrate] ${table}.${m.column} 已添加`);
          } catch (e2) {
            console.error(`[migrate] ${table}.${m.column} 补列失败（下次启动会重试）：${e2.message}`);
          }
        }
      }
    } finally {
      conn.release();
    }
  }
}

// 索引迁移：老库补索引，热路径（渠道选择/日志聚合）在大表上不再全表扫
// 注意：索引光写在建表 SQL 里不够 —— CREATE TABLE IF NOT EXISTS 对已存在的表不生效，
// 而有数据、真正需要索引的恰恰是老库。
const INDEX_MIGRATIONS = [
  "CREATE INDEX idx_channels_status_priority ON channels (status, priority)",
  "CREATE INDEX idx_logs_type_created ON logs (type, created_at)",
  "CREATE INDEX idx_logs_user_type_created ON logs (user_id, type, created_at)",
  // 渠道统计/筛选走 channel_id 列（替代原 JSON_EXTRACT detail）。
  // 用复合索引而不是单列：查询恒带 type=2 + created_at 范围，复合索引能把这三种条件
  // 一次吃下（单列 channel_id 仍要回表过滤 type/时间，大渠道上差别明显）。
  "CREATE INDEX idx_logs_channel_type_created ON logs (channel_id, type, created_at)",
  // 按模型筛选（列表页恒带 type=2）
  "CREATE INDEX idx_logs_model_type ON logs (model, type)",
  // 修复进度公示（/api/buildlog）按令牌名前缀查维护流量（fb4*/cc*），该接口是公开的
  // 且前端 15s 轮询 —— 没有这个索引就是每次全表扫（logs 按调用量线性增长）。
  // 前缀 LIKE（'fb4%'）可以走 B+Tree 范围扫描。
  "CREATE INDEX idx_logs_token_name ON logs (token_name)",
];

async function ensureIndexes() {
  // 先清掉被复合索引取代的旧单列索引：idx_logs_channel / idx_logs_model 是早期版本建的，
  // 现在的查询恒带 type + created_at，复合索引已完全覆盖它们的用途；
  // 留着只会让每次写日志多维护两棵 B+Tree（写放大）。
  for (const name of ["idx_logs_channel", "idx_logs_model"]) {
    try {
      await pool.query(`DROP INDEX ${name} ON logs`);
      console.log(`[migrate] 已移除冗余索引 ${name}（复合索引已覆盖）`);
    } catch {
      /* 不存在（新库）或权限不足：都不影响启动 */
    }
  }
  for (const ddl of INDEX_MIGRATIONS) {
    try {
      await pool.query(ddl);
      console.log(`[migrate] 索引已创建：${ddl.match(/idx_\w+/)?.[0] || ddl}`);
    } catch (e) {
      if (e?.code !== "ER_DUP_KEYNAME") console.warn(`[migrate] 索引创建失败（忽略）：${e.message}`);
    }
  }

  // 单聊唯一键的唯一索引：CREATE TABLE IF NOT EXISTS 对已存在的表不生效，
  // 所以老库（以及本次上线时已建好 chat_rooms 的库）必须单独补。
  // 没有这个唯一索引，单聊房间的唯一性就只靠代码里的「先查再插」——
  // 并发点两次「发消息」会各建一个房间，双方各看一个，消息永远对不上。
  try {
    await pool.query("CREATE UNIQUE INDEX uniq_room_single ON chat_rooms (single_key)");
    console.log("[migrate] 索引已创建：uniq_room_single");
  } catch (e) {
    if (e?.code !== "ER_DUP_KEYNAME") console.warn(`[migrate] uniq_room_single 创建失败（忽略）：${e.message}`);
  }
}

// 分组数据迁移（幂等）：
//   · 老库 channels.groups 为空 → 用 group_name 回填（group_name 为 default 时视为未分组）
//   · **default 不再是分组**：公共池用「空数组」表达，渠道/用户/密钥上的历史 default 一并清理
async function ensureGroups() {
  const [rows] = await pool.query("SELECT id, type, group_name, group_list FROM channels");
  for (const r of rows) {
    let list = [];
    try {
      const arr = r.group_list ? JSON.parse(r.group_list) : [];
      if (Array.isArray(arr)) list = arr.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      list = [];
    }
    const legacy = String(r.group_name || "").trim();
    if (!list.length && legacy && legacy !== "default") list = [legacy];
    const next = [...new Set(list.filter((g) => g !== "default"))];
    if (JSON.stringify(next) !== String(r.group_list || "[]")) {
      await pool.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
        JSON.stringify(next),
        next[0] || "",
        r.id,
      ]);
    }
  }
  // 历史 default 绑定清空：用户分组与密钥绑定（default 已改为「公共池」语义）
  await pool.query("UPDATE users SET group_name = '' WHERE group_name = 'default'").catch(() => {});
  await pool
    .query("UPDATE tokens SET group_name = '' WHERE group_name = 'default' OR group_name LIKE '%:default'")
    .catch(() => {});
  // 旧库列默认值同步（新渠道/新用户默认就是「未分组」）
  await pool.query("ALTER TABLE channels ALTER COLUMN group_name SET DEFAULT ''").catch(() => {});
  await pool.query("ALTER TABLE users ALTER COLUMN group_name SET DEFAULT ''").catch(() => {});
}

/**
 * 频道体系下线（第 79 批）：把挂在子频道上的聊天房间置为「已解散」(status=2)。
 *
 * 为什么是软解散而不是删：消息与成员行原样保留（回滚代码即可复活），
 * 而所有读写入口本来就只认 status=1 的房间 —— 会话列表、未读红点、搜索、
 * 发消息都会自动把它们排除，不必在每条 SQL 里再加 guild_channel_id 过滤。
 * 幂等：只处理仍是 status=1 的频道房间，重复执行无副作用。
 */
async function retireGuildRooms() {
  const [r] = await pool
    .query("UPDATE chat_rooms SET status = 2 WHERE guild_channel_id <> 0 AND status = 1")
    .catch(() => [{ affectedRows: 0 }]);
  if (r?.affectedRows) console.log(`[migrate] 频道体系已下线：${r.affectedRows} 个频道房间置为已解散（消息保留）`);
}

async function columnExists(table, column) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  return rows[0].c > 0;
}

export async function migrate() {
  for (const sql of TABLES) await pool.query(sql);
  const hadGroupRate = await columnExists("channel_groups", "rate");
  await ensureColumns();
  await ensureIndexes();
  await ensureColumnTypes();
  await migrateGroupVendor();
  await ensureGroups();
  await retireGuildRooms();
  if (!hadGroupRate) {
    // 本升级独有的清理：旧版按厂商自动种子出来的 default 分组行（非管理员创建）
    await pool.query("DELETE FROM channel_groups WHERE name = 'default'").catch(() => {});
  }
}

/**
 * 分组表的厂商字段迁移：`type` → `vendor`，且唯一键从 (type, name) 改为 (name)。
 *
 * 为什么改：`type` 原语义是「分组按厂商隔离」（NOT NULL + 联合唯一键 + 成员同步时
 * `WHERE type = ?`），结果管理员建分组必须先选厂商、且只能选同厂商的账号。
 * 用户要的是「分组可包含多个渠道，**或者**指定哪个厂商」——厂商只是建组时的
 * 可选筛选便利，分组本身要能跨厂商。
 *
 * 幂等：用 information_schema 判断列/索引是否已迁移，重复执行无副作用。
 */
async function migrateGroupVendor() {
  const hasType = await columnExists("channel_groups", "type");
  const hasVendor = await columnExists("channel_groups", "vendor");
  try {
    if (hasType && !hasVendor) {
      // 改名（保留已有数据）；同时把 NOT NULL 放宽为「可为空串」
      await pool.query("ALTER TABLE channel_groups CHANGE COLUMN type vendor VARCHAR(32) NOT NULL DEFAULT ''");
      console.log("[migrate] channel_groups.type 已改名为 vendor（语义：可选的厂商筛选）");
    }
    // 唯一键：删掉旧的 (type, name)，建 (name)。分组名全局唯一才能跨厂商。
    const [idx] = await pool.query("SHOW INDEX FROM channel_groups");
    const names = new Set(idx.map((r) => r.Key_name));
    if (names.has("uniq_group_type_name")) {
      await pool.query("ALTER TABLE channel_groups DROP INDEX uniq_group_type_name");
      console.log("[migrate] 已移除旧唯一键 uniq_group_type_name(type,name)");
    }
    if (!names.has("uniq_group_name")) {
      // 先检查有没有重名分组（跨厂商同名）——有就先改名避免加索引失败，
      // 而不是让整个迁移失败导致服务起不来。
      const [dups] = await pool.query(
        "SELECT name, COUNT(*) AS c FROM channel_groups GROUP BY name HAVING c > 1"
      );
      if (dups.length) {
        // 已占用的名字集合：改名目标不能与任何现有分组撞车，
        // 否则会出现两行同名 → 唯一键建不起来 → 每次启动都失败且永不自愈。
        const taken = new Set(
          (await pool.query("SELECT name FROM channel_groups"))[0].map((r) => String(r.name))
        );
        for (const d of dups) {
          const [rows] = await pool.query(
            "SELECT id, vendor FROM channel_groups WHERE name = ? ORDER BY id",
            [d.name]
          );
          // 第一条保留原名，其余改名
          for (let i = 1; i < rows.length; i += 1) {
            const oldName = String(d.name);
            taken.delete(oldName); // 允许后续行用原名（它们正在改走）
            let newName = "";
            // 候选：原名-厂商 / 原名-序号；都撞车就用 g<id>。
            // 注意留出后缀长度，避免 slice 把后缀整个截掉导致 newName === oldName。
            for (const suffix of [String(rows[i].vendor || ""), `g${rows[i].id}`, `${i}`]) {
              if (!suffix) continue;
              const cand = `${oldName.slice(0, Math.max(0, 32 - suffix.length - 1))}-${suffix}`;
              if (!taken.has(cand)) {
                newName = cand;
                break;
              }
            }
            if (!newName) newName = `group-${rows[i].id}`.slice(0, 32);
            taken.add(newName);

            // 改名必须**同步传播**到渠道与已绑定的 Key：
            // 只改 channel_groups 会让原成员渠道仍指向旧名字，
            // 于是它们静默并入「保留下来的那个同名分组」（跨厂商串组），
            // 绑了旧名的 Key 也会静默换到别的分组上按错误倍率计费。
            await pool.query("UPDATE channel_groups SET name = ? WHERE id = ?", [newName, rows[i].id]);
            const [chans] = await pool.query("SELECT id, group_list FROM channels");
            for (const c of chans) {
              let list = [];
              try {
                const arr = c.group_list ? JSON.parse(c.group_list) : [];
                if (Array.isArray(arr)) list = arr.map((x) => String(x));
              } catch {
                list = [];
              }
              if (!list.includes(oldName)) continue;
              const next = [...new Set(list.map((x) => (x === oldName ? newName : x)))];
              await pool.query("UPDATE channels SET group_list = ?, group_name = ? WHERE id = ?", [
                JSON.stringify(next),
                next[0] || "",
                c.id,
              ]);
            }
            // Key 绑定：新格式（纯名字）与旧格式（厂商:名字）都要处理
            await pool.query("UPDATE tokens SET group_name = ? WHERE group_name = ?", [newName, oldName]);
            await pool.query("UPDATE tokens SET group_name = ? WHERE group_name LIKE ?", [
              newName,
              `%:${oldName}`,
            ]);
            console.warn(`[migrate] 分组「${oldName}」重名，已重命名为「${newName}」并同步渠道与密钥绑定`);
          }
        }
      }
      await pool.query("ALTER TABLE channel_groups ADD UNIQUE KEY uniq_group_name (name)");
      console.log("[migrate] 已建立唯一键 uniq_group_name(name)（分组名全局唯一，支持跨厂商）");
    }
  } catch (e) {
    // 迁移失败不阻塞启动（补列/索引是幂等的，下次启动会重试）
    console.error("[migrate] 分组厂商字段迁移失败（下次启动重试）：", e.message);
  }
}
