'use strict';

/**
 * Langdock Proxy Manager
 * ----------------------
 * 多代理管理平台: 通过 Docker 编排多个反代实例, 提供 Web UI + REST API.
 *
 * 架构:
 *   - manager 自己也跑在容器里, 挂载 /var/run/docker.sock 控制宿主 Docker
 *   - 每个代理 = 一个反代容器 (基于 proxy.js 镜像)
 *   - 配置持久化到 /data/proxies.json
 *   - 日志通过 docker logs 拉取
 *
 * REST API (除 /api/auth 外都要 Bearer token):
 *   POST   /api/auth              { token } → 验证, 返回 session
 *   GET    /api/proxies            → 列出所有代理
 *   POST   /api/proxies            → 创建代理 { name, target, port, prefix, cookieDomain, cookiePath, rewriteBody }
 *   GET    /api/proxies/:id        → 单个代理详情
 *   PUT    /api/proxies/:id        → 更新配置 (会重建容器)
 *   DELETE /api/proxies/:id        → 删除代理 (停+删容器)
 *   POST   /api/proxies/:id/start  → 启动
 *   POST   /api/proxies/:id/stop   → 停止
 *   POST   /api/proxies/:id/restart→ 重启
 *   GET    /api/proxies/:id/logs?tail=200 → 获取日志
 *   GET    /api/proxies/:id/status → 容器状态
 *
 * 环境变量:
 *   MANAGER_PORT   监听端口 (默认 8080)
 *   MANAGER_TOKEN  访问 token (必填, 没有则随机生成并打印)
 *   DATA_DIR       配置存储目录 (默认 /data)
 *   PROXY_IMAGE    反代镜像名 (默认 langdock-proxy, 即同 repo 构建的镜像)
 */

const express = require('express');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

// ---------- 配置 ----------
const PORT = process.env.MANAGER_PORT || 8080;
let TOKEN = process.env.MANAGER_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'proxies.json');
const PROXY_IMAGE = process.env.PROXY_IMAGE || 'langdock-proxy:latest';

if (!TOKEN) {
  TOKEN = crypto.randomBytes(12).toString('hex');
  console.log('\n========================================');
  console.log('  未设置 MANAGER_TOKEN, 已随机生成:');
  console.log('  ' + TOKEN);
  console.log('  请妥善保存, 后续登录需要. 设置 MANAGER_TOKEN 环境变量可固定.')
  console.log('========================================\n');
}

// 确保 data 目录存在
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Docker ----------
// Docker 不可用时 docker=null, 容器操作返回友好错误, 但 API/UI 仍可用
let docker = null;
let dockerError = null;
try {
  docker = new Docker({ socketPath: '/var/run/docker.sock' });
  // 立即 ping 一次, 确认 socket 可达 (避免后续每个操作才发现)
  // 用同步方式: 尝试 dockerode 的 listContainers
} catch (e) {
  dockerError = e.message;
  console.warn('[manager] Docker 初始化失败:', e.message);
  console.warn('  容器操作将不可用, 但 Web UI / API / 配置管理仍可正常工作.');
  console.warn('  若在容器内运行, 请挂载 /var/run/docker.sock');
}

// ---------- 配置存储 ----------
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    return { proxies: [] };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function genId() {
  return 'p_' + crypto.randomBytes(4).toString('hex');
}

// ---------- 容器名 ----------
function containerName(id) {
  return 'langdock-proxy-' + id;
}

// ---------- 启动一个反代容器 ----------
async function startProxyContainer(p) {
  if (!docker) throw new Error('Docker 不可用: ' + (dockerError || 'socket 未挂载'));
  const name = containerName(p.id);
  // 先清理同名旧容器
  try {
    const old = docker.getContainer(name);
    const info = await old.inspect();
    if (info.State.Running) await old.stop();
    await old.remove();
  } catch (e) { /* 不存在, 忽略 */ }

  const env = [
    `PROXY_PORT=${p.port || 3000}`,
    `PROXY_TARGET=${p.target}`,
    `PROXY_PREFIX=${p.prefix || ''}`,
    `COOKIE_DOMAIN=${p.cookieDomain || ''}`,
    `COOKIE_PATH=${p.cookiePath || '/'}`,
    `REWRITE_BODY=${p.rewriteBody === false ? 'false' : 'true'}`,
    `DEBUG=${p.debug ? '1' : '0'}`,
  ];

  await docker.createContainer({
    Image: PROXY_IMAGE,
    name,
    Env: env,
    HostConfig: {
      PortBindings: { [`${p.port || 3000}/tcp`]: [{ HostPort: String(p.hostPort || p.port || 3000) }] },
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });
  await docker.getContainer(name).start();
}

// ---------- 停止并删除容器 ----------
async function stopProxyContainer(id) {
  const name = containerName(id);
  try {
    const c = docker.getContainer(name);
    const info = await c.inspect();
    if (info.State.Running) await c.stop();
    await c.remove();
  } catch (e) { /* 忽略 */ }
}

// ---------- 获取容器状态 ----------
async function getContainerStatus(id) {
  if (!docker) return { exists: false, running: false, status: 'docker_unavailable' };
  const name = containerName(id);
  try {
    const info = await docker.getContainer(name).inspect();
    return {
      exists: true,
      running: info.State.Running,
      status: info.State.Status,
      ip: info.NetworkSettings.IPAddress,
      ports: info.NetworkSettings.Ports,
    };
  } catch (e) {
    return { exists: false, running: false, status: 'not_created' };
  }
}

// ---------- 获取容器日志 ----------
function getContainerLogs(id, tail = 200) {
  if (!docker) return Promise.resolve('[Docker 不可用, 无法获取日志]');
  return new Promise((resolve) => {
    const name = containerName(id);
    // 用 docker logs 命令, 比 dockerode 流更简单
    exec(`docker logs --tail ${tail} ${name} 2>&1`, (err, stdout) => {
      if (err) {
        resolve('[无日志或容器不存在]');
      } else {
        resolve(stdout || '[空]');
      }
    });
  });
}

// ---------- Express ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 认证中间件
function auth(req, res, next) {
  const t = req.headers.authorization;
  if (t === 'Bearer ' + TOKEN || req.query.token === TOKEN) {
    return next();
  }
  // Web UI 通过 cookie 登录
  if (req.headers.cookie && req.headers.cookie.includes('mgr_token=' + TOKEN)) {
    return next();
  }
  return res.status(401).json({ error: 'unauthorized' });
}

// 对 /api/* (除 /api/auth) 应用认证
app.use('/api', (req, res, next) => {
  if (req.path === '/auth') return next();
  auth(req, res, next);
});

// ---------- API ----------

// 登录
app.post('/api/auth', (req, res) => {
  const { token } = req.body || {};
  if (token === TOKEN) {
    res.json({ ok: true, token: TOKEN });
  } else {
    res.status(401).json({ error: 'invalid token' });
  }
});

// 验证 token 是否有效
app.get('/api/auth/verify', auth, (req, res) => {
  res.json({ ok: true });
});

// 列出所有代理
app.get('/api/proxies', async (req, res) => {
  const cfg = loadConfig();
  const list = await Promise.all(cfg.proxies.map(async (p) => {
    const status = await getContainerStatus(p.id);
    return { ...p, status };
  }));
  res.json({ proxies: list });
});

// 创建代理
app.post('/api/proxies', async (req, res) => {
  const { name, target, port, prefix, cookieDomain, cookiePath, rewriteBody, debug } = req.body || {};
  if (!name || !target) {
    return res.status(400).json({ error: 'name and target are required' });
  }
  const cfg = loadConfig();
  const p = {
    id: genId(),
    name,
    target,
    port: port || 3000,
    hostPort: port || 3000,
    prefix: prefix || '',
    cookieDomain: cookieDomain || '',
    cookiePath: cookiePath || '/',
    rewriteBody: rewriteBody !== false,
    debug: !!debug,
    createdAt: new Date().toISOString(),
  };
  cfg.proxies.push(p);
  saveConfig(cfg);
  try {
    await startProxyContainer(p);
    res.json({ ok: true, proxy: p });
  } catch (e) {
    res.status(500).json({ error: 'start failed: ' + e.message, proxy: p });
  }
});

// 单个代理详情
app.get('/api/proxies/:id', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const status = await getContainerStatus(p.id);
  res.json({ ...p, status });
});

// 更新代理 (重建容器)
app.put('/api/proxies/:id', async (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.proxies.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  const updates = req.body || {};
  Object.assign(cfg.proxies[idx], updates, { updatedAt: new Date().toISOString() });
  saveConfig(cfg);
  await stopProxyContainer(cfg.proxies[idx].id);
  try {
    await startProxyContainer(cfg.proxies[idx]);
    res.json({ ok: true, proxy: cfg.proxies[idx] });
  } catch (e) {
    res.status(500).json({ error: 'restart failed: ' + e.message });
  }
});

// 删除代理
app.delete('/api/proxies/:id', async (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.proxies.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  await stopProxyContainer(cfg.proxies[idx].id);
  cfg.proxies.splice(idx, 1);
  saveConfig(cfg);
  res.json({ ok: true });
});

// 启动
app.post('/api/proxies/:id/start', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    await startProxyContainer(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停止
app.post('/api/proxies/:id/stop', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  await stopProxyContainer(p.id);
  res.json({ ok: true });
});

// 重启
app.post('/api/proxies/:id/restart', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  await stopProxyContainer(p.id);
  try {
    await startProxyContainer(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 日志
app.get('/api/proxies/:id/logs', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const tail = parseInt(req.query.tail, 10) || 200;
  const logs = await getContainerLogs(p.id, tail);
  res.json({ logs });
});

// 状态
app.get('/api/proxies/:id/status', async (req, res) => {
  const cfg = loadConfig();
  const p = cfg.proxies.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  const status = await getContainerStatus(p.id);
  res.json(status);
});

// 系统信息
app.get('/api/system', async (req, res) => {
  const cfg = loadConfig();
  let dockerInfo = { available: false, running: 0, total: 0 };
  if (docker) {
    try {
      const info = await docker.info();
      dockerInfo = { available: true, running: info.ContainersRunning, total: info.Containers };
    } catch (e) {
      dockerInfo = { available: false, error: e.message };
    }
  }
  res.json({
    docker: dockerInfo,
    proxies: cfg.proxies.length,
    image: PROXY_IMAGE,
  });
});

// ---------- 启动 ----------
app.listen(PORT, () => {
  console.log(`\nLangdock Proxy Manager 已启动`);
  console.log(`  监听:  http://0.0.0.0:${PORT}`);
  console.log(`  Web UI: http://0.0.0.0:${PORT}/`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  配置:  ${CONFIG_FILE}`);
  console.log('');
});

// 启动时确保所有已配置的代理容器在运行 (重启 manager 后自愈)
async function reconcile() {
  if (!docker) {
    console.log('[reconcile] Docker 不可用, 跳过自愈');
    return;
  }
  const cfg = loadConfig();
  console.log(`[reconcile] 检查 ${cfg.proxies.length} 个代理...`);
  for (const p of cfg.proxies) {
    try {
      const s = await getContainerStatus(p.id);
      if (!s.running) {
        console.log(`[reconcile] 启动 ${p.name} (${p.id})...`);
        try { await startProxyContainer(p); } catch (e) { console.error(`[reconcile] ${p.id} 启动失败:`, e.message); }
      } else {
        console.log(`[reconcile] ${p.name} 已在运行`);
      }
    } catch (e) {
      console.error(`[reconcile] ${p.id} 状态检查失败:`, e.message);
    }
  }
}
reconcile().catch(e => console.error('[reconcile] error', e.message));
