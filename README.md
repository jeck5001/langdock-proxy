# Langdock Proxy

围绕 [app.langdock.com](https://app.langdock.com) 的两个工具:

1. **Manager** — 多代理反代管理平台: Web UI + REST API + Docker 编排, 管理多个反代容器
2. **Bridge** — LLM API 转换: 把 Langdock 账号转成 OpenAI / Claude / Codex 兼容 API, 让 Claude Code / Codex / Cursor 直接当 LLM 后端用 (类似 QCCG)

两者打包在同一个 Docker 镜像里, 由 docker-compose 的 command 字段决定跑哪个.

## 架构

```
┌─────────────────────────────────────────┐
│  Manager 容器 (Web UI + REST API)        │
│  - Express 后端 (manager.js)             │
│  - 静态前端 (public/index.html)          │
│  - 通过 dockerode 控制宿主 Docker         │
└──────────────┬──────────────────────────┘
               │ docker.sock
               ▼
┌─────────────────────────────────────────┐
│  宿主 Docker                             │
│  ┌─────────────┐  ┌─────────────┐  ...  │
│  │ proxy 容器 A │  │ proxy 容器 B │       │
│  │ (langdock)   │  │ (其他目标)   │       │
│  └─────────────┘  └─────────────┘       │
└─────────────────────────────────────────┘
```

- **manager** — 管理平台, 跑在容器里, 挂载 `/var/run/docker.sock` 控制宿主 Docker
- **proxy 容器** — 每个代理实例一个容器, 基于 `langdock-proxy:latest` 镜像, 跑 `proxy.js`
- **配置** — 持久化到 `./data/proxies.json`

## 快速开始

镜像由 GitHub Actions 自动构建并推送到 [ghcr.io/jeck5001](https://github.com/jeck5001/langdock-proxy/pkgs).
NAS 上无需构建, 直接拉取部署:

```bash
# 1. 克隆配置 (只需要 compose 文件, 不需要源码)
git clone https://github.com/jeck5001/langdock-proxy.git
cd langdock-proxy

# 2. 改 docker-compose.yml 里的 MANAGER_TOKEN 成你自己的强密码
#    (必改! 默认是 changeme-please)

# 3. 启动 manager
docker compose up -d

# 4. 看 token (如果没改 MANAGER_TOKEN 的话, 这里会显示随机生成的)
docker compose logs manager | grep Token

# 5. 打开 Web UI
open http://<nas-ip>:8080
```

在 UI 里点「新建代理」, 填名称/target/端口, 保存即可. manager 会自动拉取反代镜像并启动一个代理容器.

## 配置

编辑 `docker-compose.yml` 里 manager 服务的环境变量:

| 变量 | 默认 | 说明 |
|---|---|---|
| `MANAGER_PORT` | `8080` | manager 监听端口 |
| `MANAGER_TOKEN` | *(随机生成)* | 访问 token, **务必改成强密码** |
| `DATA_DIR` | `/data` | 配置存储目录 (容器内, 挂载到 `./data`) |
| `PROXY_IMAGE` | `langdock-proxy:latest` | 反代容器使用的镜像 |

## REST API

所有 `/api/*` (除 `/api/auth`) 需要 Bearer token 认证:

```
Authorization: Bearer <MANAGER_TOKEN>
```

### 认证

```
POST /api/auth              { "token": "xxx" }   → 验证 token
GET  /api/auth/verify                            → 验证当前 token
```

### 代理管理

```
GET    /api/proxies                    列出所有代理
POST   /api/proxies                    创建代理
GET    /api/proxies/:id                单个代理详情
PUT    /api/proxies/:id                更新配置 (会重建容器)
DELETE /api/proxies/:id                删除代理 (停+删容器)
POST   /api/proxies/:id/start          启动
POST   /api/proxies/:id/stop           停止
POST   /api/proxies/:id/restart        重启
GET    /api/proxies/:id/logs?tail=200  查看日志
GET    /api/proxies/:id/status         容器状态
```

### 系统信息

```
GET    /api/system                     Docker 信息 + 代理计数
```

### 创建代理的 body

```json
{
  "name": "langdock",
  "target": "https://app.langdock.com",
  "port": 3001,
  "prefix": "/langdock",
  "cookieDomain": "",
  "cookiePath": "/",
  "rewriteBody": true,
  "debug": false
}
```

### 在 Codex / Claude Code / 脚本里调用

```bash
# 列出所有代理
curl -H "Authorization: Bearer $TOKEN" http://nas:8080/api/proxies

# 创建一个新代理
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"openai","target":"https://api.openai.com","port":3002}' \
  http://nas:8080/api/proxies

# 看某代理日志
curl -H "Authorization: Bearer $TOKEN" http://nas:8080/api/proxies/<id>/logs?tail=100

# 重启
curl -X POST -H "Authorization: Bearer $TOKEN" http://nas:8080/api/proxies/<id>/restart
```

在 Claude Code 里可以直接用 bash 工具调这些 curl, 或者写一个 MCP server 包装这些 API (留给读者练习).

## 单个反代的配置 (proxy.js)

每个 proxy 容器跑 `proxy.js`, 通过环境变量配置:

| 变量 | 默认 | 说明 |
|---|---|---|
| `PROXY_PORT` | `3000` | 容器内监听端口 |
| `PROXY_TARGET` | `https://app.langdock.com` | 源站 |
| `PROXY_PREFIX` | *(空)* | 路径前缀, 如 `/langdock` |
| `COOKIE_DOMAIN` | *(请求 Host)* | Cookie 写入的 Domain |
| `COOKIE_PATH` | `/` | Cookie 写入的 Path |
| `REWRITE_BODY` | `true` | 重写响应体里的绝对 URL |
| `DEBUG` | `0` | 调试日志 |

## 功能特性 (proxy.js)

- **WebSocket 透传** — `ws: true`
- **Set-Cookie 改写** — `Domain`/`Path`/`Secure`/`SameSite` 让登录态在反代域名下可用
- **响应体 URL 重写** — 绝对 URL 替换成反代主机, 避免跳回源站
- **Location 重定向改写** — 302 自动贴路径前缀
- **自动解压** — gzip/br/deflate 自动解压重写后再压缩返回

## 文件结构

```
langdock-proxy/
├── manager.js              # 管理平台后端 (Express + dockerode)
├── proxy.js                # 反代引擎 (http-proxy-middleware v3)
├── public/
│   └── index.html          # Web UI 单页
├── Dockerfile              # 反代引擎镜像
├── Dockerfile.manager      # 管理平台镜像 (含 docker-cli)
├── docker-compose.yml      # 编排
├── package.json
└── data/                   # 持久化配置 (运行时生成)
    └── proxies.json
```

## 开发

```bash
# 不用 Docker, 直接跑 manager (需要本机有 docker daemon)
MANAGER_TOKEN=devtoken DATA_DIR=./data node manager.js

# 直接跑单个 proxy
PROXY_TARGET=https://app.langdock.com PROXY_PORT=3000 node proxy.js
```

## License

MIT

---

# Bridge: Langdock → OpenAI/Claude/Codex API

把 Langdock 账号转成兼容 API, 让 Claude Code / Codex / Cursor 直接当 LLM 后端用.

## 原理

```
Claude Code / Codex / Cursor
    │  (OpenAI / Claude / Codex 格式)
    ▼
Bridge (bridge.js)  ← 本服务
    │  (Langdock /api/engine 格式, Cookie 认证)
    ▼
app.langdock.com  → Claude / GPT
```

Bridge 接收标准 OpenAI/Anthropic 格式请求, 转成 Langdock 的 `/api/engine` 格式, 用你提供的 Cookie 调用 Langdock, 再把响应转回标准格式.

## 暴露的端点

| 端点 | 格式 | 客户端 |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI Chat | Cursor / Continue / OpenAI SDK |
| `POST /v1/messages` | Anthropic Claude | Claude Code |
| `POST /v1/responses` | OpenAI Responses | Codex |
| `GET /v1/models` | OpenAI | 所有 |

## 部署

Bridge 已经包含在 `docker-compose.yml` 里, 和 manager 一起部署:

```bash
# 1. 创建 .env 文件, 填入 Langdock Cookie
cat > .env <<EOF
MANAGER_TOKEN=your-manager-password
LANGDOCK_COOKIE=你从浏览器抓的完整 Cookie
BRIDGE_TOKEN=your-bridge-password  # 可选, 保护 bridge API
EOF

# 2. 启动
docker compose up -d
```

## 抓取 Langdock Cookie

1. 浏览器打开 `app.langdock.com`, 登录
2. F12 打开开发者工具 → Network 标签
3. 发一条聊天消息, 找到 `/api/engine` 请求
4. 右键 → Copy → Copy as cURL, 或在 Headers 里找到 `Cookie:` 头
5. 复制整个 Cookie 值, 填到 `.env` 的 `LANGDOCK_COOKIE=`

**注意**: Cookie 会过期, 需要定期更新. 如果 bridge 返回错误, 先检查 Cookie 是否失效.

## 客户端配置

### Claude Code

```bash
# 设置环境变量
export ANTHROPIC_BASE_URL=http://<nas-ip>:8963
export ANTHROPIC_API_KEY=<你的 BRIDGE_TOKEN, 没设则任意>
```

### Codex

```bash
export OPENAI_BASE_URL=http://<nas-ip>:8963/v1
export OPENAI_API_KEY=<你的 BRIDGE_TOKEN, 没设则任意>
```

### Cursor

Settings → Models → OpenAI API Key 填 BRIDGE_TOKEN, Base URL 填:
```
http://<nas-ip>:8963/v1
```

## 调试

如果响应不正常, 开 DEBUG 看原始响应:

```bash
# .env 里设
DEBUG=1
docker compose restart bridge
docker compose logs -f bridge
```

DEBUG 模式会打印 Langdock 的原始响应, 可以看到响应格式, 方便定位问题.

## 局限

- Cookie 认证: Langdock 用 Cookie 维持会话, Cookie 过期需要重新抓取
- Cloudflare: Langdock 有 CF 防护, 如果 NAS IP 和登录 IP 差异大, `cf_clearance` 可能失效
- 非流式: 当前响应是"收集完整再返回", 不是真正的流式 (后续可改)
