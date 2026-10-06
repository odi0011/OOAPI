// 固定方法目录同时驱动原生工具、参数说明、审批预览和交付清单。
// 不接受模型传 URL / HTTP 方法，也不另写一套越过业务路由的 SQL。
const groups = {};
function group(id, name, role, rows) {
  groups[id] = { id, name, role, actions: Object.fromEntries(rows.trim().split("\n").map(row => {
    const [action, verb, path, title, fields = "", query = "", note = ""] = row.trim().split("|");
    return [action, { action, verb, path, title, fields: fields.split(" ").filter(Boolean), query: query.split(" ").filter(Boolean), note, write: verb !== "GET", role }];
  })) };
}
group("models", "平台模型", 1, `
available|GET|/api/chat/meta|查询当前可用模型与能力||keyId q vendor p size|按本人的密钥分组、模型白名单和渠道交集返回；keyId 省略时沿用当前对话选中的密钥，非对话调用才使用首个启用密钥。支持关键词、厂商和分页。
prices|GET|/api/pricing/public|查询公开模型价格||q p size|每百万 Token 的 OD 单价；遵守平台价格可见性。
providers|GET|/api/catalog|查看平台集成厂商
status|GET|/api/status|查看站点公开状态
`);
group("community", "社区帖子与评论", 1, `
topics|GET|/api/community/topics|浏览社区话题||all
posts|GET|/api/community/posts|搜索或浏览最新帖子||p size tab status topic_id user_id q following favorited sort|sort=new 最新发布，active 最新活动，hot 热门；先查真实帖子编号再评论。
post|GET|/api/community/posts/:id|阅读指定帖子
comments|GET|/api/community/posts/:id/comments|阅读帖子评论||p size
publish|POST|/api/community/posts|代你发布帖子|title content topic_id media_ids||title、content、topic_id 必填；media_ids 仅用本人已有媒体。
edit|PUT|/api/community/posts/:id|编辑自己的帖子|title content topic_id media_ids
delete|DELETE|/api/community/posts/:id|删除帖子
comment|POST|/api/community/posts/:id/comments|在指定帖子发表评论或回复|content media_ids parent_id reply_to_user_id||回复时 parent_id 必须来自该帖真实评论；普通评论不填回复编号。
delete_comment|DELETE|/api/community/comments/:id|删除评论
like|POST|/api/community/posts/:id/like|切换帖子点赞|||切换操作：先读当前状态，避免重复反转。
favorite|POST|/api/community/posts/:id/favorite|切换帖子收藏
like_comment|POST|/api/community/comments/:id/like|切换评论点赞
follow|POST|/api/community/users/:id/follow|切换关注用户
summary|GET|/api/community/me/summary|查看自己的社区统计
create_topic|POST|/api/community/topics|创建社区话题|name description icon image_media_id sort
edit_topic|PUT|/api/community/topics/:id|编辑社区话题|name description icon image_media_id sort status
delete_topic|DELETE|/api/community/topics/:id|删除话题并迁移帖子|move_to|move_to
moderate|POST|/api/community/posts/:id/moderate|审核帖子或置顶|status is_pinned
recount|POST|/api/community/admin/recount|重算社区计数
`);
for (const a of ["create_topic", "edit_topic", "delete_topic", "moderate", "recount"]) groups.community.actions[a].role = 100;
group("notifications", "通知", 1, `
list|GET|/api/community/notifications|阅读自己的通知||p size
unread|GET|/api/community/notifications/unread|查看未读通知数量
read|POST|/api/community/notifications/read|标记通知已读|ids||ids 为通知编号数组；省略表示全部已读。
delete|DELETE|/api/community/notifications/:id|删除通知
`);
group("people", "个人资料与好友", 1, `
me|GET|/api/profile/me|阅读自己的个人主页
preferences|GET|/api/user/self|读取自己的当前偏好设置|||只返回当前账号的非敏感设置，修改偏好时服务端保留未提及的项。
profile|GET|/api/profile/u/:id|阅读用户公开主页
posts|GET|/api/profile/u/:id/posts|阅读用户公开帖子||p size
follows|GET|/api/profile/u/:id/follows|查看关注或粉丝||p size kind|kind=following 或 followers。
edit_profile|PUT|/api/users/self|修改自己的公开资料|display_name email bio website location
settings|PUT|/api/users/self/settings|修改个人偏好|*||只提交用户要求修改的字段；服务端读取原设置并递归合并，审批显示变更，写入后读回核对。数组按完整新数组替换。
friends|GET|/api/friends|查看好友列表
requests|GET|/api/friends/requests|查看好友申请
relation|GET|/api/friends/relation/:id|查看与用户的关系
request|POST|/api/friends/requests|发送好友申请|to_user_id message
respond|PUT|/api/friends/requests/:id|接受或拒绝好友申请|action||action=accept 或 reject。
cancel_request|DELETE|/api/friends/requests/:id|撤回好友申请
remark|PUT|/api/friends/:id/remark|修改好友备注|remark
remove|DELETE|/api/friends/:id|删除好友
chat|POST|/api/friends/:id/chat|打开与好友的私聊
`);
group("messages", "站内私信与群聊", 1, `
online|GET|/api/chatroom/online|查看在线用户
search|GET|/api/chatroom/search|搜索可见聊天内容||q p size
users|GET|/api/chatroom/users|查找聊天用户||q
unread|GET|/api/chatroom/unread|查看聊天未读数量
rooms|GET|/api/chatroom/rooms|查看自己的会话列表||p size
room|GET|/api/chatroom/rooms/:id|查看群聊或私聊详情
history|GET|/api/chatroom/rooms/:id/messages|阅读聊天消息||since_id p size
create|POST|/api/chatroom/rooms|创建私聊或群聊|type name user_ids user_id||type=single、group 或 discussion；成员必须符合平台好友规则。
send|POST|/api/chatroom/rooms/:id/messages|向指定会话发送消息|type content media_ids client_id||正文 content 必填；type=text。必须先核对会话和收件人。
delete_message|DELETE|/api/chatroom/messages/:id|撤回消息
read|POST|/api/chatroom/rooms/:id/read|标记会话已读|message_id
invite|POST|/api/chatroom/rooms/:id/members|邀请群聊成员|user_ids
leave|DELETE|/api/chatroom/rooms/:id/members/me|退出群聊
remove_member|DELETE|/api/chatroom/rooms/:id/members/:userId|移除群聊成员
delete_room|DELETE|/api/chatroom/rooms/:id|删除或解散聊天会话
announcement|PUT|/api/chatroom/rooms/:id/announcement|修改群公告|announcement
rename|PUT|/api/chatroom/rooms/:id/name|修改群名称|name
`);
group("workspace", "对话", 1, `
sessions|GET|/api/chat/sessions|查找自己的 AI 对话||q limit archived
session|GET|/api/chat/sessions/:id|阅读自己的 AI 对话
create|POST|/api/chat/sessions|新建 AI 对话|model settings
edit|PUT|/api/chat/sessions/:id|修改 AI 对话标题或设置|title model settings todo
batch|POST|/api/chat/sessions/batch|批量归档、恢复、置顶或删除 AI 对话|ids action||action=archive、unarchive、pin、unpin、delete；不能修改当前正在执行工具的对话。
delete|DELETE|/api/chat/sessions/:id|删除 AI 对话
rewind|POST|/api/chat/sessions/:id/rewind|回退指定 AI 对话|fromSeq
running|GET|/api/chat/sessions/:id/running|查看 AI 对话执行状态
stop|POST|/api/chat/sessions/:id/stop|停止另一个 AI 对话
`);
group("tokens", "API 令牌", 1, `
list|GET|/api/token|查看自己的令牌||p size|不返回密钥明文。
groups|GET|/api/token/groups|查看自己可用的令牌分组
create|POST|/api/token|创建 API 令牌|name remain_quota unlimited_quota expired_time model_limits group_name||额度使用平台整数单位，10000 单位=1 OD；创建后密钥仅在令牌页面查看。
edit|PUT|/api/token|修改令牌|id name status remain_quota unlimited_quota expired_time model_limits group_name||status=1启用/2禁用；expired_time 为 Unix 秒。
delete|DELETE|/api/token/:id|删除自己的令牌
reconcile|GET|/api/token/reconcile|核对令牌用量
`);
group("media", "媒体库", 1, `
list|GET|/api/media|查询可见媒体||p size user_id kind q status
stats|GET|/api/media/stats|查看媒体空间统计||user_id
detail|GET|/api/media/:id|查看媒体元信息
rename|PATCH|/api/media/:id|重命名媒体|orig_name
delete|DELETE|/api/media/:id|删除媒体||force|已引用媒体遵守原有引用保护；force 仅按原接口管理员权限。
delete_avatar|DELETE|/api/media/avatar|移除自己的头像
gc|POST|/api/media/gc|回收无引用媒体|limit
`);
groups.media.actions.gc.role = 100;
group("usage", "使用记录与看板", 1, `
records|GET|/api/log/usage|查询可见使用记录||p size user_id token_id channel_id model status type start end days keyword group group_name
operations|GET|/api/log/operation|查询操作日志||p size user_id type start end days keyword
filters|GET|/api/log/usage/filters|查看使用记录筛选项||days
summary|GET|/api/log/usage/summary|统计可见使用量||user_id token_id model status start end days group
analysis|GET|/api/log/usage/analysis|分析可见用量趋势||days user_id token_id model start end group
personal|GET|/api/dashboard/self|查看个人数据看板||days
community|GET|/api/dashboard/community|查看社区看板||days
admin|GET|/api/dashboard/admin|查看管理数据看板||days user_id token_id
admin_filters|GET|/api/dashboard/filters|查看管理看板筛选项
clear_logs|DELETE|/api/log|清空全部使用记录和操作日志|||永久清空全站全部日志；没有按日期清理能力，不能向用户描述为部分清理。
`);
for (const a of ["operations", "admin", "admin_filters"]) groups.usage.actions[a].role = 100;
groups.usage.actions.clear_logs.role = 1000;
group("channels", "渠道与分组管理", 100, `
list|GET|/api/channel|查询渠道||p size type keyword status method
stats|GET|/api/channel/stats|查看渠道汇总
detail_stats|GET|/api/channel/:id/stats|查看渠道用量||days
recovery|GET|/api/channel/:id/recovery|查看渠道恢复状态
providers|GET|/api/channel/providers|查看渠道接入方式
groups|GET|/api/channel/groups|查看渠道分组
create_group|POST|/api/channel/groups|创建渠道分组|vendor type name remark rate models channel_ids
edit_group|PUT|/api/channel/groups/:id|修改渠道分组|vendor name remark rate models channel_ids
delete_group|DELETE|/api/channel/groups/:id|删除渠道分组
edit|PUT|/api/channel|修改渠道非凭据配置|id name status models groups group_name priority weight base_url remark auto_ban auto_test auto_test_interval test_prompt test_model concurrency min_gap_ms max_per_min fingerprint_mode context_billing namespace probe_timeout_sec
delete|DELETE|/api/channel/:id|删除渠道
batch|POST|/api/channel/batch|批量操作渠道|ids action payload||action=enable、disable、delete、set_priority、set_group、add_models；payload 对应目标配置。
test|POST|/api/channel/:id/test|测试渠道可用性|model||测试可能产生上游用量。
quota|POST|/api/channel/:id/quota|刷新渠道额度
upstream_models|POST|/api/channel/:id/upstream-models|探测渠道上游模型
`);
group("pricing", "模型价格与能力管理", 100, `
list|GET|/api/pricing|查询模型定价||keyword type
capabilities|GET|/api/pricing/capabilities|查询模型能力||model
set_capabilities|PUT|/api/pricing/capabilities|设置模型能力与完整价格|model capabilities pricing||pricing 支持管理页的完整定价对象；能力与价格须传完整配置，可先 capabilities 按 model 查询原值。
pending|GET|/api/pricing/pending|查看待定价模型
catalog_pending|GET|/api/pricing/catalog-pending|查看待确认模型目录
set|PUT|/api/pricing|修改模型价格|model input_price output_price cache_price channel_type remark offpeak_input_price offpeak_output_price offpeak_cache_price offpeak_rule||单价为 OD/百万 Token。只提交需修改字段，服务端先读原值保留缓存价、闲时价和备注，审批展示修改前后，写入后读回核对；新模型必须给出输入和输出单价。
delete|DELETE|/api/pricing/:model|删除模型定价
import|POST|/api/pricing/import|批量导入模型定价|text||text 为 JSON 或 CSV 格式的价格数据，沿用原导入校验。
prune|POST|/api/pricing/prune|清理未使用模型定价
sync_upstream|POST|/api/pricing/sync-upstream|从已配置上游同步价格|overwrite
sync_precheck|GET|/api/pricing/sync-precheck|预检价格同步
sync_defaults|POST|/api/pricing/sync-defaults|同步平台默认价格
attributions|GET|/api/pricing/attribution|查看模型归属确认
attribute|POST|/api/pricing/attribution|确认模型别名归属|alias model
delete_attribution|DELETE|/api/pricing/attribution|撤销模型归属确认|alias
resolve|GET|/api/pricing/resolve|解析模型身份||model
`);
group("users", "用户管理", 100, `
list|GET|/api/users|搜索平台用户||p size keyword
edit|PUT|/api/users/:id|修改用户资料、状态或角色|role status display_name email||角色任免仍需原接口的超管权限。
quota|POST|/api/users/:id/quota|调整用户额度|quota||额度为整数单位；10000单位=1 OD，具体增减以原接口规则为准。
delete|DELETE|/api/users/:id|删除用户
`);
group("monitor", "运维监控与告警", 100, `
snapshot|GET|/api/monitor/snapshot|查看资源与网关监控
metrics|GET|/api/monitor/alert/metrics|查看告警指标字典
rules|GET|/api/monitor/alert/rules|查看告警规则
create_rule|POST|/api/monitor/alert/rules|创建告警规则|name metric operator threshold window_min sustained_min cooldown_min severity enabled notify_email notify_webhook webhook_url notify_emails filters description
edit_rule|PUT|/api/monitor/alert/rules/:id|修改告警规则|name metric operator threshold window_min sustained_min cooldown_min severity enabled notify_email notify_webhook webhook_url notify_emails filters description
delete_rule|DELETE|/api/monitor/alert/rules/:id|删除告警规则
toggle_rule|POST|/api/monitor/alert/rules/:id/toggle|切换告警规则启用状态
events|GET|/api/monitor/alert/events|查询告警事件||days limit status severity
resolve|POST|/api/monitor/alert/events/:id/resolve|解决告警事件
evaluate|POST|/api/monitor/alert/evaluate|立即评估告警规则|force
silence|POST|/api/monitor/alert/silence|设置告警静默|minutes reason
test|POST|/api/monitor/alert/test|发送测试告警通知|channel to url
config|GET|/api/monitor/alert/config|查看告警通知配置
cleanup|POST|/api/monitor/alert/cleanup|清理历史告警|days
`);
group("system", "系统设置与更新", 100, `
options|GET|/api/option|查看系统非敏感配置
save_options|PUT|/api/option|保存系统非敏感配置|*||仅修改用户明确指定的项；敏感凭据和 agent_flow 必须通过设置页面操作。
update_check|GET|/api/update/check|检查平台更新
update_status|GET|/api/update/status|查看平台更新状态
update_apply|POST|/api/update/apply|执行平台更新|||会构建并重启平台；必须确认影响后操作。
`);
groups.system.actions.update_apply.role = 1000;
group("trading", "币安交易工作台", 1, `
status|GET|/api/binance/status|查看交易服务状态
dashboard|GET|/api/binance/dashboard|查看自己的交易看板||account_id
equity|GET|/api/binance/equity|查看权益曲线||account_id limit
accounts|GET|/api/binance/accounts|查看自己的交易账户
positions|GET|/api/binance/positions|查看仓位||account_id
orders|GET|/api/binance/orders|查看订单||account_id limit
strategies|GET|/api/binance/strategies|查看策略||account_id
events|GET|/api/binance/strategies/:id/events|查看策略事件||limit
backtests|GET|/api/binance/backtests|查看回测||strategy_id limit
protections|GET|/api/binance/protection-orders|查看保护单||account_id
risk|GET|/api/binance/risk/:id|查看账户风控
platform|GET|/api/binance/platform|查看自己的交易配置
create_demo|POST|/api/binance/accounts|创建模拟交易账户|name||只创建 demo；真实或测试网凭据须在交易配置页面绑定。
edit_account|PATCH|/api/binance/accounts/:id|修改交易账户名称或启用状态|name active
delete_account|DELETE|/api/binance/accounts/:id|删除交易账户
sync|POST|/api/binance/accounts/:id/sync|同步交易账户
validate|POST|/api/binance/accounts/:id/validate|验证已绑定交易账户
create_strategy|POST|/api/binance/strategies|创建交易策略|account_id name symbol timeframe strategy_type fast_period slow_period quantity auto_execute position_side||strategy_type=moving_average/rsi；timeframe=1m/5m/15m/1h/4h/1d；自动执行会持续交易，必须明确告知。
edit_strategy|PATCH|/api/binance/strategies/:id|修改或启停策略|status parameters||status=running/paused；parameters 为完整策略参数。
delete_strategy|DELETE|/api/binance/strategies/:id|删除策略
run_strategy|POST|/api/binance/strategies/:id/run|执行一次策略
backtest|POST|/api/binance/backtests|运行回测|strategy_id limit initial_balance fee_rate slippage
set_risk|PUT|/api/binance/risk/:id|设置账户风控|trading_halted max_margin_ratio max_order_notional max_daily_loss max_open_positions max_leverage liquidation_buffer_pct||先读取现有风控并合并，只改用户指定字段。
set_protection|PUT|/api/binance/positions/:id/protection|设置仓位止盈止损|stop_loss take_profit trailing_pct
order|POST|/api/binance/orders|提交交易订单|account_id symbol side quantity reduce_only position_side mode client_order_id||side=BUY/SELL；mode=demo/testnet/live 必须由用户明确指定；symbol、数量、方向、账户和模式全部确认，禁止自动启用真实交易。
close|POST|/api/binance/positions/:id/close|平仓|percentage client_order_id||percentage 为0到1的比例；先查仓位确认账户、交易模式和数量。
cancel_order|POST|/api/binance/orders/:id/cancel|撤销订单
refresh_order|POST|/api/binance/orders/:id/refresh|刷新订单状态
network|POST|/api/binance/platform/network|测试交易网络连接
set_platform|PUT|/api/binance/platform|保存自己的交易连接配置|allow_live_trading proxy_url||必须先读取当前配置并合并；开启真实交易须用户明确要求并确认，不能为执行订单自行打开。
`);
export const PLATFORM_CATALOG = groups;
export const PLATFORM_TOOL_IDS = ["platform", ...Object.keys(groups)];
export function platformAction(tool, args) { const actions = Object.hasOwn(groups, tool) ? groups[tool].actions : null; const action = String(args?.action || ""); return actions && Object.hasOwn(actions, action) ? actions[action] : null; }
export const needsToolApproval = (tool, args) => platformAction(tool, args)?.write === true;
export function visiblePlatformCatalog(role = 1, enabledTools = null) {
  const enabled = enabledTools == null ? null : new Set(enabledTools);
  return Object.values(groups).filter(g => g.role <= role && (!enabled || enabled.has(g.id))).map(g => ({ id: g.id, name: g.name, actions: Object.values(g.actions).filter(a => a.role <= role).map(({ path, verb, ...a }) => ({ ...a, params: [...path.matchAll(/:(\w+)/g)].map(m => m[1]) })) }));
}
