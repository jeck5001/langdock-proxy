# Langdock Proxy Manager

多代理反代管理平台: 通过 Web UI 或 REST API 管理多个反向代理实例, 每个实例是一个 Docker 容器, 基于 [http-proxy-middleware](https://github.com/chimurai/http-proxy-middleware) 实现, 支持 WebSocket, Cookie/URL 重写.

专为反代 [app.langdock.com](https://app.langdock.com) 设计, 但可以反代任意目标.

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

# 3. 预拉取反代镜像 (manager 创建代理时会用到)
docker compose --profile pull pull

# 4. 启动 manager
docker compose up -d

# 5. 看 token (如果没改 MANAGER_TOKEN 的话, 这里会显示随机生成的)
docker compose logs manager | grep Token

# 6. 打开 Web UI
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
