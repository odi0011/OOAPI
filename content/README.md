# 币安广场内容管线

把市场数据、新闻和持仓整理成广场帖子：**抓新闻 → 生成合规文案 → 配 K 线图 → 草稿队列 → 人工审核 / 官方 API 发布**。

底层使用币安 **2026-03 官方开放的 Square OpenAPI**（`binance-skills-hub` 的
`square-post` skill），不做客户端伪装、不逆向接口。

## 1. 一次性准备

1. 打开 <https://www.binance.com/square/creator-center/home>，创建
   **Square OpenAPI Key**。
   - 每个创作者账号 1 个 key；它与资产/交易接口完全隔离，只能发帖。
2. 保存 key（不要写进仓库）：

   ```bash
   cd content/square-post
   BINANCE_SQUARE_OPENAPI_KEY=你的key node scripts/save-key.mjs
   ```

   或每次运行时用环境变量 `BINANCE_SQUARE_OPENAPI_KEY` 注入。
3. Node.js 18+（当前机器已满足）。

## 2. 用法

```bash
# 查看状态（key 是否就绪、今天发了几条）
python content/run.py status

# 生成日报草稿（只写文件，不联网发布）
python content/run.py daily

# 抓新闻，挑一条生成草稿
python content/run.py news

# 人工审核后发布某个草稿目录
python content/run.py approve content/outbox/20261017-145244-daily

# 直接发布（review_mode=true 时需要 --force）
python content/run.py daily --publish --force
```

草稿目录结构：

```
content/outbox/20261017-145244-daily/
├── post.txt     # 正文
├── meta.json    # 类型、配图文件名、新闻来源
└── _chart.png   # K 线配图
```

默认 `review_mode: true`：`--publish` 不会直接发，必须走 `approve` 或加
`--force`。建议先人工看几轮，再考虑全自动。

## 3. 合规护栏

广场社区规则明确禁止 **机器人刷屏、批量同质内容、操纵市场**：

- `config.json` 的 `banned_phrases` 会在生成时拦截“保证/稳赚/必涨/喊单/
  目标价”等表述；
- 所有文案强制带免责声明；
- 提到持仓时只写实际数据，不写方向预测；
- 默认每天最多 **2 条**（平台上限 100 条/天，我们刻意远低于它）；
- 新闻帖只做公开信息摘要，不复制全文、不写“利好/利空”结论；
- 同一新闻 topic 在 `dedupe_hours`（默认 24h）内不重复发。

**不要**把 `banned_phrases` 删空来“提高通过率”——被平台降权或封号
比少发几条严重得多。

## 4. 定时任务

官方 skill 只负责“创建帖子”，不提供定时/草稿/删除。定时由本机 cron 负责。

Linux crontab 示例（北京时间由系统时区决定）：

```cron
# 每天 09:07 生成并发布日报
7 9 * * * cd /opt/ooapi && HTTPS_PROXY=http://127.0.0.1:7897 python content/run.py daily --publish --force >> content/cron.log 2>&1

# 每 30 分钟检查一次新闻，只有分数达标且未发过的才会生成
17,47 * * * * cd /opt/ooapi && HTTPS_PROXY=http://127.0.0.1:7897 python content/run.py news --publish --force >> content/cron.log 2>&1
```

建议先用 `daily`（不带 `--publish`）观察几天，再开启新闻自动发布。

## 5. 配置

`content/config.json`：

| 字段 | 说明 |
|---|---|
| `symbols` | 日报里的币种 |
| `daily_post_hour` | 日报目标小时（定时任务里用） |
| `max_posts_per_day` | 每日上限，默认 2 |
| `review_mode` | true = 必须人工 approve |
| `include_positions` | 是否在日报里带个人持仓 |
| `disclosure` | 免责声明 |
| `banned_phrases` | 禁用词 |
| `news.binance_catalogs` | 币安公告栏目（48 上币 / 49 最新 / 161 API） |
| `news.min_score` | 新闻入选分数 |
| `news.dedupe_hours` | 同题去重窗口 |
| `square.script_dir` | 官方脚本目录 |

持仓数据来自本地 OOAPI 管理接口，需要：

```bash
export OOAPI_BASE=http://127.0.0.1:3001
export OOAPI_ADMIN_USER=...
export OOAPI_ADMIN_PASS=...
```

读不到就自动跳过持仓段落，不影响发帖。

## 6. 目录

```
content/
├── config.json
├── run.py            # CLI
├── market.py         # 行情快照 + K 线图
├── news.py           # 币安公告 + Cointelegraph RSS
├── compose.py        # 文案模板 + 合规过滤
├── positions.py      # 读账户级持仓
├── publish.py        # 调用官方 Node 脚本
├── test_compliance.py
└── square-post/          # 官方 skill（原样 vendored）
```

官方脚本来源：
<https://github.com/binance/binance-skills-hub/tree/main/skills/binance/square-post>

## 7. 已知限制

- 官方 OpenAPI 只支持**创建**，不支持读取、编辑、删除、定时；定时靠本机 cron。
- 图片最多 4 张；文章模式只能 1 张封面。
- 平台每日 100 条 / 400 次上传；本管线默认 2 条/天。
- 新闻源目前是币安公告 + Cointelegraph；需要更多源可在 `news.py` 里加。
- 文案是模板生成，不带 LLM；如果要更自然的表达，可以在 `compose.py`
  里接 OOAPI 自己的 `/v1/chat/completions`，但必须保留合规过滤。
