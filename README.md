# OOAPI

大模型 API 网关与分发平台。把多家上游模型统一成一个 **OpenAI 兼容接口**，并提供令牌分发、额度计费、用量日志与多用户管理。

```
你的应用 ──► OOAPI (/v1/chat/completions) ──► 各上游模型服务
                    │
                    ├── 令牌校验（sk-xxx）
                    ├── 按模型选择账号（优先级 + 权重）
                    ├── 失败自动切换；账号全挂时占住连接等待恢复
                    └── 按 token 精确计费（OD币）
```

## 功能

**对外接口**

- 三种协议入口：`/v1/chat/completions`（OpenAI）、`/v1/messages`（Anthropic，Claude Code）、`/v1/responses`（Responses，Codex）
- 流式（SSE）与非流式；图片输入（多模态）在三种协议间完整搬运
- `/v1/models` 按密钥所属分组过滤，只返回该密钥真正能调的模型

**多渠道调度**

- 同一模型可配多个账号，按「优先级降序 + 同级权重轮询」分配
- 单账号异常自动切换并临时冷却，对调用方透明
- **等待室**：所有账号都不可用时（冷却中 / 被禁用 / 上游 5xx），
  占住连接并每分钟回报进度，账号恢复后无缝接上真实回答。
  最长等待 50 分钟，超时以协议错误事件收尾 —— 让本地 agent
  （Codex / Claude Code 的重试次数写死）不会因几次失败就断掉会话

**账号与模型**

- 账号级模型**绑定**：上游自造的名字（`default-model` / `fast-model`）绑到真实模型，
  一个账号一套绑定（同一个 `default-model` 在不同上游可以是完全不同的模型）
- 绑定连带写入官方定价与能力参数；未绑定的别名不允许保存（避免按 0 计费）
- 设备授权与订阅登录：Kiro / WorkBuddy / Grok / Codex / Claude / Google（Antigravity）
- 按模型的协议路由（`model_paths`）、自定义请求头、出口代理、TLS 指纹、账号级限流

**计费与运营**

- 按提示/补全/缓存 token 精确计费，支持长上下文阶梯价
- 币种为 **OD币（1 OD = 1 美元）**，额度单位 1 OD = 10,000
- 用户、分组、额度充值/扣减、角色管理
- 全链路日志（模型、tokens、费用、账号、IP、首字耗时），可按类型检索
- 模型定价表、消费分析、媒体库

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Go 1.23+ · Gin · MySQL 5.7+ · JWT |
| 前端 | React 19 · TypeScript · Vite · [Arc UI](https://uiarc.dev/) |
| 部署 | systemd + nginx（HTTPS 由 nginx 终止） |

## 目录结构

```
OOAPI/
├── ooapi-server/                后端（Go）
│   ├── main.go                  入口：加载配置、连库、建表、创建管理员、启动
│   ├── internal/
│   │   ├── config/              配置（.env + 环境变量）
│   │   ├── db/                  连接与建表/自动补列
│   │   ├── router/              路由与中间件装配
│   │   ├── handlers/            HTTP 处理：对外接口、管理端、各协议翻译
│   │   ├── services/            调度、计费、定价、模型目录、账号凭据
│   │   └── ...
│   └── go.mod
├── ooapi-web/                   前端（React + Arc UI）
│   └── src/
│       ├── pages/admin/         管理端页面
│       ├── components/arc/      Arc UI 组件
│       └── components/admin/    业务组件
├── scripts/
│   ├── deploy-server.sh         编译后端并部署（本地交叉编译 + 健康检查回滚）
│   ├── deploy-web.sh            构建前端并部署（原子替换）
│   └── ssh-oo.sh                SSH/SCP 助手（读 ~/.ooapi-server-pass）
└── ai协作.md                    项目规范、变更记录与踩坑史
```

## 环境要求

- **Go ≥ 1.23**（构建后端）
- **Node.js ≥ 20**（构建前端）
- **MySQL ≥ 5.7**（推荐 8.0）
- nginx（对外提供 HTTPS；后端本身只监听 `127.0.0.1`）

## 快速部署

### 1. 准备数据库

服务会自动建表（含老库缺列时的自动补齐），但**需要你先建好库和账号**：

```sql
CREATE DATABASE ooapi DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ooapi'@'127.0.0.1' IDENTIFIED BY '换成你自己的密码';
GRANT ALL PRIVILEGES ON ooapi.* TO 'ooapi'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 2. 配置后端

在运行目录创建 `.env`（权限 600）：

```ini
PORT=3001
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ooapi
DB_PASSWORD=你刚设置的数据库密码
DB_NAME=ooapi
WEB_DIR=/opt/ooapi/web/dist

# 超管账号（首次启动创建；已存在管理员时不会覆盖）
ADMIN_USERNAME=odi
ADMIN_PASSWORD=你的初始密码

# 可选：Google 订阅登录（Antigravity / Gemini CLI）所需的 OAuth 客户端凭据。
# 在 Google Cloud Console 创建 OAuth 客户端时获得。
# 不配置则「Google 订阅一键登录」不可用，其他功能不受影响。
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

`JWT_SECRET` 未设置时会在运行目录自动生成 `.jwt-secret`（0600）——
**该文件不要提交，也不要在部署时覆盖**，否则所有登录态失效。

### 3. 构建与启动

```bash
# 后端：本地交叉编译出静态二进制
cd ooapi-server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o ooapi-server-bin .

# 前端
cd ../ooapi-web
npm install && npm run build     # 产物在 dist/
```

systemd 单元（示例）：

```ini
[Unit]
Description=OOAPI gateway and web platform
After=network.target mysqld.service

[Service]
Type=simple
WorkingDirectory=/opt/ooapi/server
ExecStart=/opt/ooapi/ooapi-server-bin
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

前端产物交给 nginx 托管（`root /opt/ooapi/web/dist`），
后端只处理 `/api/`、`/v1/`、`/uploads/`。

### 4. nginx（关键配置）

对外接口是 SSE 长连接，这三项**缺一不可**：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    proxy_buffering off;          # 缓冲会让前端「卡着不出字」
    proxy_read_timeout 600s;      # 思考型模型可能几十秒不出字；等待室最长 50 分钟
    proxy_send_timeout 600s;
    client_max_body_size 32m;     # 图片 base64 会撑大请求体
}
```

### 5. 一键部署脚本

仓库自带 `scripts/deploy-server.sh` 与 `scripts/deploy-web.sh`：

- 后端脚本在**本地交叉编译**后上传，原子替换 + 重启 + 健康检查，不通过自动回滚
- 前端脚本先把产物传到临时目录再整体替换，避免访问中的页面拿到半新半旧的资源

两者都通过 `scripts/ssh-oo.sh` 连接服务器，默认从 `~/.ooapi-server-pass` 读密码；
换服务器只需改 `ssh-oo.sh` 里的 `HOST`。

## 默认管理员账号

| 项 | 值 |
|---|---|
| 用户名 | `.env` 里的 `ADMIN_USERNAME`（默认 `root`） |
| 密码 | `.env` 里的 `ADMIN_PASSWORD`；未设置时随机生成并写入 `.admin-password`（0600） |

创建时机：**首次启动**时，`users` 表中不存在管理员则自动创建。

> 登录后请立刻修改密码。

**忘记密码**：删掉超管记录后重启（未设置 `ADMIN_PASSWORD` 会重新生成随机密码）：

```sql
DELETE FROM users WHERE role >= 1000;
```

## 使用说明

### 1. 接入上游账号

**账号管理 → 添加账号**：

1. 选厂商与接入方式（API Key / 设备授权 / 订阅登录）
2. 填 **接口地址** 与 **上游密钥**；授权类账号点「一键登录」
3. 点「从上游获取模型列表」拉取该账号支持的模型
4. 若清单里有上游自造的名字（`default-model` 等），在下方**逐个绑定真实模型** ——
   绑定后官方定价与能力参数会自动配好；未绑定无法保存
5. 需要时设置**所属分组**、优先级、权重、限流

> 同一模型配多个账号时：**优先级**决定先用哪个，**权重**决定同级分流。
> 某账号报错会自动临时冷却并切换；全部不可用时会进入等待室而不是直接报错。

### 2. 维护模型定价

**模型定价 → 模型定价** 页按模型维护单价（OD币 / 百万 token），分输入 / 输出 / 缓存三档。
绑定真实模型时会自动写入官方价，可再手工调整。

### 3. 用户与令牌

- **用户管理**：改角色、启停账号、增减额度
- **密钥管理**：用户创建 `sk-` 密钥，可设额度上限、模型白名单、有效期；
  密钥**只在创建时完整显示一次**

### 4. 调用接口

```bash
curl https://你的域名/v1/chat/completions \
  -H "Authorization: Bearer sk-你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

Python（OpenAI SDK）：

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌",
    base_url="https://你的域名/v1",
)
resp = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

Anthropic 协议（Claude Code）与 Responses 协议（Codex）分别把 base URL 指向
`/v1` 即可，服务端会自动适配。

## 计费说明

| 项 | 说明 |
|---|---|
| 币种 | **OD币**，1 OD = 1 美元 |
| 额度单位 | 1 OD = 10,000 单位（支持 `0.0001 OD` 精度） |
| 计费公式 | `(提示tokens/1e6 × 输入价 + 补全tokens/1e6 × 输出价 + 缓存tokens/1e6 × 缓存价) × 10000` |
| 最小计费 | 向上取整，单次最低 1 单位 |

## 接口一览

**对外（OpenAI / Anthropic 兼容，需 `sk-` 令牌）**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 对话补全（OpenAI 协议，支持 `stream`） |
| POST | `/v1/messages` | Messages 协议（Claude Code） |
| POST | `/v1/messages/count_tokens` | token 计数 |
| POST | `/v1/responses` | Responses 协议（Codex） |
| POST | `/v1/responses/compact` | 上下文压缩 |
| GET | `/v1/models` | 可用模型列表（按密钥分组过滤） |

**后台（需登录 JWT）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 站点公开配置 |
| POST | `/api/auth/login` | 登录 |
| GET/POST/PUT/DELETE | `/api/admin/*` | 账号、分组、定价、用户、日志等管理接口 |
| GET/PUT/DELETE | `/api/token/*` | 密钥管理 |

## 开发约定

- 项目规范、变更记录与踩坑史记在 **`ai协作.md`**，改完代码回写其中「变更记录」
- 提交前确保 `go build ./...` 与 `go test ./...` 通过
- **绝不提交**：`.env`、`.jwt-secret`、`.admin-password`、`data/`、`uploads/`、`node_modules/`
- 上游凭据（API Key、OAuth client secret）一律走环境变量，不写进源码
