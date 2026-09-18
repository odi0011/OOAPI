# OOAPI

大模型 API 网关与分发平台。把多家上游模型统一成一个 **OpenAI 兼容接口**，并提供令牌分发、额度计费、用量日志与多用户管理。

```
你的应用 ──► OOAPI (/v1/chat/completions) ──► 各上游模型服务
                    │
                    ├── 令牌校验（sk-xxx）
                    ├── 按模型选择渠道（优先级 + 权重）
                    ├── 失败自动切换下一渠道
                    └── 按 token 精确计费（OD币）
```

## 功能

- **OpenAI 兼容接口**：`/v1/chat/completions`，改个 `baseURL` 即可接入现有应用；同时支持流式（SSE）与非流式
- **多渠道调度**：同一模型可配置多个渠道，按「优先级降序 + 同级轮询」分配；单渠道异常时自动切换并临时冷却
- **令牌分发**：为每个应用签发独立密钥，可限制额度上限、模型白名单、有效期
- **精确计费**：按提示/补全 token 计费，支持缓存命中价；币种为 **OD币（1 OD = 1 美元）**
- **用户与额度**：多用户、分组、额度充值/扣减、管理员与普通用户角色
- **全链路日志**：每次调用记录模型、tokens、费用、渠道、IP，可按类型检索
- **模型定价**：按模型维护单价（OD币 / 百万 token），内置常见模型默认价，可随时调整
- **系统设置**：站点名称、注册开关、新用户赠送额度等均可在后台修改，无需改代码
- **在线更新**：后台一键检查并拉取 GitHub 最新代码更新（见「升级」）

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Node.js 18+ · Express · MySQL（mysql2）· JWT |
| 前端 | React 18 · Vite · Ant Design |
| 部署 | systemd + nginx（建议） |

## 目录结构

```
OOAPI/
├── ooapi-server/          后端服务
│   ├── src/
│   │   ├── index.js       入口：建表、创建默认管理员、启动 HTTP
│   │   ├── db.js          数据库连接与建表
│   │   ├── config.js      系统设置（存 options 表，带默认值）
│   │   ├── routes/        auth / user / token / log / option / channel /
│   │   │                  pricing / gateway(/v1) / chat
│   │   ├── services/      计费、日志、模型、渠道调度、执行器、上游适配
│   │   └── middleware/    鉴权中间件
│   ├── vendor/            运行时依赖的本地资源
│   ├── public/            静态资源（logo 等）
│   ├── migrate*.mjs       增量迁移脚本（可选，见下）
│   └── .env.example       环境变量模板
└── ooapi-web/             前端后台
    ├── src/pages/         渠道、定价、用户、令牌、日志、设置、对话
    ├── src/components/    通用组件
    └── public/icons/      厂商图标
```

---

## 环境要求

- **Node.js ≥ 18**
- **MySQL ≥ 5.7**（推荐 8.0）
- 可选：nginx（对外提供 HTTPS；服务本身只监听 `127.0.0.1`）

## 快速部署

### 1. 准备数据库

服务会自动建表，但**需要你先建好库和账号**：

```sql
CREATE DATABASE ooapi DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'ooapi'@'127.0.0.1' IDENTIFIED BY '换成你自己的密码';
GRANT ALL PRIVILEGES ON ooapi.* TO 'ooapi'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 2. 配置后端

```bash
cd ooapi-server
npm install
cp .env.example .env
```

编辑 `.env`：

```ini
PORT=3001
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ooapi
DB_PASSWORD=你刚设置的数据库密码
DB_NAME=ooapi

# 超级管理员初始密码（首次启动创建 root 账号时使用）
# 不设置则随机生成并写入 ooapi-server/.admin-password（0600），日志只提示文件路径
ADMIN_PASSWORD=

# JWT 签名密钥，留空会自动生成并保存到 .jwt-secret（该文件不要提交）
JWT_SECRET=
```

### 3. 启动后端（首次启动会建表并创建管理员）

```bash
npm start          # 前台运行，确认无误
# 或开发模式： npm run dev
```

首次启动的日志里会出现：

```
[init] 已创建默认管理员 root（密码来自 ADMIN_PASSWORD 环境变量）。
# 或（未设置 ADMIN_PASSWORD 时）：
[init] 已创建默认管理员 root；随机密码已写入 .../ooapi-server/.admin-password（0600）。登录后请立即改密并删除该文件。
[ooapi-server] listening on 127.0.0.1:3001
```

> 建表 + 建管理员**只在第一次启动时执行一次**；之后启动会跳过。

### 4. 构建前端

```bash
cd ../ooapi-web
npm install
npm run build
```

构建产物在 `ooapi-web/dist/`，复制到后端静态目录：

```bash
mkdir -p ../ooapi-server/web
cp -r dist/* ../ooapi-server/web/
```

> 后端从 `ooapi-server/web/` 提供前端页面，所以**每次前端改动都要重新构建并复制**，
> 且复制前最好先清空 `ooapi-server/web/assets/`，避免旧哈希文件残留。

### 5. 访问

浏览器打开 `http://服务器IP:3001`，用下方管理员账号登录。

### 6. 生产部署（systemd + nginx）

`/etc/systemd/system/ooapi.service`：

```ini
[Unit]
Description=OOAPI backend
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=/opt/ooapi/ooapi-server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now ooapi
```

nginx 反向代理（顺带解决 HTTPS）：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 流式响应必须关掉缓冲，否则会「攒够一批才吐出」
        proxy_buffering off;
        proxy_read_timeout 600s;
    }
}
```

> **流式输出务必加 `proxy_buffering off;`**，否则客户端会感到明显卡顿。

---

## 默认管理员账号

| 项 | 值 |
|---|---|
| 地址 | `http://<你的域名或IP>:3001/login` |
| 用户名 | `root` |
| 密码 | `.env` 里的 `ADMIN_PASSWORD`；未设置时首次启动随机生成并写入 `ooapi-server/.admin-password` |

创建时机：**首次启动**时，若 `users` 表中不存在 `role >= 100` 的用户，自动创建 `root`。

> 登录后请立刻到「个人设置 → 密码」修改。

**忘记密码怎么办？** 删掉超管记录后重启服务会重新创建：

```sql
DELETE FROM users WHERE role >= 100;
```

然后重启后端，未设置 `ADMIN_PASSWORD` 时会重新生成随机密码并写入 `.admin-password` 文件。

## 使用说明

### 1. 配置渠道（接入上游模型）

进入 **渠道管理 → 添加渠道**：

1. 选择厂商（内置常见厂商的默认接口地址，也可选「自定义」接任意 OpenAI 兼容服务）
2. 填写 **Base URL** 与 **API Key**，点「从上游获取模型列表」可自动拉取
3. 选择该渠道支持的模型
4. 需要时设置**分组**、**优先级**、**权重**

添加后点该行的 ⚡ 按钮可测试连通性（会请求上游模型列表，不消耗额度）。

> 同一个模型可以配多个渠道：**优先级**决定先用哪个，**权重**决定同级之间怎么分流。
> 某个渠道报错会自动临时冷却并切换到下一个，不会影响调用方。

### 2. 维护模型定价

**模型定价** 页按模型维护单价，单位是 **OD币 / 百万 token**，分「输入 / 输出 / 缓存命中」三档。

- 内置常见模型的默认价，可直接改
- 未配置价格的模型会按兜底价计费，建议逐个确认
- 平台币种为 **OD币，1 OD = 1 美元**，最小计费精度 `0.0001 OD`

### 3. 管理用户与额度

**用户管理** 页可以：

- 调整角色（普通用户 / 管理员）
- 启用、禁用账号
- 增减额度（正数补充，负数扣减）

新用户注册时的赠送额度由 **系统设置 → 新用户赠送额度** 控制；注册开关也在这里。

### 4. 签发令牌（给应用用）

用户在 **令牌管理** 页创建自己的密钥：

- 可设**额度上限**（不设则用账号余额）
- 可设**模型白名单**（限制该密钥能调哪些模型）
- 可设**有效期**
- 可随时禁用或删除

密钥形如 `sk-xxxxxxxx`，**只在创建时完整显示一次**，请及时保存。

### 5. 调用接口

```bash
curl http://<你的域名>:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-你的令牌" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "你的模型名",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

Python（OpenAI SDK）：

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-你的令牌",
    base_url="http://你的域名:3001/v1",
)
resp = client.chat.completions.create(
    model="你的模型名",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)
```

其他 OpenAI 兼容的客户端 / 框架，只需把 `baseURL` 指到 `http://<域名>:3001/v1`、把密钥换成你的令牌即可。

---

## 计费说明

| 项 | 说明 |
|---|---|
| 币种 | **OD币**，1 OD = 1 美元 |
| 额度单位 | 1 OD = 10,000 单位（支持 `0.0001 OD` 精度） |
| 计费公式 | `(提示tokens/1e6 × 输入价 + 补全tokens/1e6 × 输出价 + 缓存tokens/1e6 × 缓存价) × 10000` |
| 最小计费 | 向上取整，单次最低 1 单位 |

> 你可以把 `OD币` 理解成「美元等价物」，站内所有金额展示、定价、日志都用它，不混用其他货币。

## 接口一览

**对外（OpenAI 兼容，需 `sk-` 令牌）**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | 对话补全（支持 `stream`） |
| GET | `/v1/models` | 当前可用模型列表 |

**后台（需登录 JWT）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 站点公开配置 |
| POST | `/api/user/login` · `/register` | 登录 / 注册 |
| GET | `/api/user/self` | 当前用户 |
| GET/POST/PUT/DELETE | `/api/token/` | 令牌管理 |
| GET | `/api/channel/` · `/providers` · `/stats` | 渠道管理 |
| GET/PUT | `/api/pricing/` | 模型定价 |
| GET | `/api/users/` | 用户管理（管理员） |
| GET | `/api/log/` | 用量日志 |
| GET/PUT | `/api/option/` | 系统设置（管理员） |
| GET/POST/PUT/DELETE | `/api/chat/sessions` | 对话会话（列表/新建/改名设定/删除） |
| GET | `/api/chat/meta` | 对话元信息（模型/智能体/工具） |
| POST | `/api/chat/run` | 运行一轮对话（SSE：正文/思考/工具/待办） |
| POST | `/api/chat/sessions/:id/rewind` | 重新生成前的回退（删除该轮问答并重算会话统计） |
| GET/POST/PUT/DELETE | `/api/chat/projects` | 对话项目（分类归档，删项目不删对话） |
| POST | `/api/chat/sessions/batch` | 批量：归档/取消归档/置顶/移动项目/删除 |
| GET | `/api/chat/sessions/:id/stream` | 重新接上进行中的生成（断线续传，先回放再续播） |
| GET | `/api/chat/sessions/:id/running` | 该会话是否正在生成 |
| GET | `/api/chat/meta?keyId=` | 元信息（按选中密钥算可用模型、厂商分组、密钥列表） |
| POST | `/api/chat/sessions/:id/stop` | 显式停止生成（切页/刷新不会中断） |

---

## 系统设置项

后台 **系统设置** 页可改（存于 `options` 表，改完即时生效）：

| 配置 | 默认 | 说明 |
|---|---|---|
| `system_name` | OOAPI | 站点名称 |
| `logo` | /logo.jpg | 站点图标 |
| `api_endpoint` | 空 | 首页展示的接口地址 |
| `quota_for_new_user` | 2000000 | 新用户赠送额度（单位，200 OD = $200） |
| `password_register_enabled` | false | 是否开放注册（默认关闭，防止被刷号） |
| `password_login_enabled` | true | 是否开放密码登录 |
| `units_per_od` | 10000 | 1 OD 等于多少额度单位 |
| `currency_name` | OD币 | 货币名称 |
| `request_timeout_ms` | 600000 | 单次上游请求超时 |

## 数据库迁移

`migrate2.mjs` / `migrate3.mjs` / `migrate5.mjs` 是**增量**脚本（幂等，可重复执行），
用于给老库补字段与迁移历史数据。**全新部署不需要手动跑**：
`db.js` 建表时已含全部字段，启动时还会自动补齐缺失的列。

老版本升级时按需执行（数据迁移部分：历史账号/额度换算）：

```bash
cd ooapi-server
node migrate5.mjs
```

---

## 升级

后台 **系统设置 → 在线更新** 可一键检查并更新到本仓库最新代码：

1. 点「检查更新」→ 显示当前版本与最新提交对比
2. 点「立即更新」→ 服务端拉取仓库最新源码、执行迁移、重建前端、重启服务

> 更新过程需要服务端能访问 `github.com`，且服务运行用户对安装目录有写权限。
> 更新前会备份当前源码到 `ooapi-server/.backup-<时间戳>/`，出问题可手动回滚。

手动升级（等价做法）：

```bash
cd /opt/ooapi
git clone --depth 1 https://github.com/odi0011/OOAPI /tmp/ooapi-new
# 覆盖源码，保留 .env / data / node_modules / web
rsync -a --exclude='.env' --exclude='.jwt-secret' --exclude='data/' --exclude='node_modules/' \
      /tmp/ooapi-new/ooapi-server/ /opt/ooapi/ooapi-server/
rsync -a --exclude='node_modules/' /tmp/ooapi-new/ooapi-web/ /opt/ooapi/ooapi-web/
cd /opt/ooapi/ooapi-web && npm install && npm run build
cp -r dist/* /opt/ooapi/ooapi-server/web/
systemctl restart ooapi
```

## 安全建议

- **首次启动前**设好 `ADMIN_PASSWORD`，别用默认值
- `.env` 与 `.jwt-secret` **不要提交**到仓库（已在 `.gitignore` 中）
- 对外务必走 HTTPS（nginx + 证书），令牌是明文 Bearer
- 数据库账号只授权本库，不要用 root
- 定期备份 `ooapi` 库；`ooapi-server/data/` 也要备份（含运行状态）

## License

[Apache License 2.0](./LICENSE)
