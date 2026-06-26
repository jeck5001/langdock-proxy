'use strict';

/**
 * Langdock Proxy Manager
 * ----------------------
 * 多代理管理平台: Web UI + REST API + Docker 编排
 */

const express = require('express');
const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
let docker = null;
let dockerError = null;
try {
  docker = new Docker({ socketPath: '/var/run/docker.sock' });
} catch (e) {
  dockerError = e.message;
  console.warn('[manager] Docker 初始化失败:', e.message);
  console.warn('  容器操作将不可用, 但 Web UI / API / 配置管理仍可正常工作.');
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
app.use(express.json({ limit: '10mb' }));

// 静态文件 (Web UI)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 认证中间件 ----------
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

// 代理 /api/v1/* 到 bridge 的 /v1/* 路由
// bridge 模块的路由是 /v1/*, 但 UI 的 api() 函数会加 /api 前缀
// 这里我们需要把 /api/v1/* 的请求转发给 bridge 处理
app.use('/api/v1', auth, (req, res, next) => {
  // bridge 模块期望路径是 /v1/*, 所以需要重写
  req.url = '/v1' + req.url;
  req.originalUrl = '/v1' + req.originalUrl;
  bridgeModule(req, res, next);
});

// ---------- LLM Bridge (OpenAI/Claude/Codex 兼容 API) ----------
const bridgeModule = require('./bridge');

// 挂载 bridge 路由 (需要认证)
app.use('/', (req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    return auth(req, res, next);
  }
  next();
}, bridgeModule);

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
  try {
    const cfg = loadConfig();
    const list = await Promise.all(cfg.proxies.map(async (p) => {
      const status = await getContainerStatus(p.id);
      return { ...p, status };
    }));
    res.json({ proxies: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 创建代理
app.post('/api/proxies', async (req, res) => {
  try {
    const { name, target, port, prefix, cookieDomain, cookiePath, rewriteBody, debug, autoRestart } = req.body;
    if (!name || !target || !port) {
      return res.status(400).json({ error: 'name, target, port 必填' });
    }
    const cfg = loadConfig();
    if (cfg.proxies.find(p => p.name === name)) {
      return res.status(409).json({ error: '同名代理已存在' });
    }
    const p = {
      id: genId(),
      name, target, port,
      prefix: prefix || '',
      cookieDomain: cookieDomain || '',
      cookiePath: cookiePath || '/',
      rewriteBody: rewriteBody !== false,
      debug: !!debug,
      autoRestart: autoRestart !== false,
      createdAt: new Date().toISOString(),
    };
    cfg.proxies.push(p);
    saveConfig(cfg);
    // 创建并启动容器
    try {
      await startProxyContainer(p);
      res.status(201).json({ proxy: { ...p, status: 'running' } });
    } catch (e) {
      res.status(201).json({ proxy: { ...p, status: 'start_failed' }, error: e.message });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 查看单个
app.get('/api/proxies/:id', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    const status = await getContainerStatus(p.id);
    res.json({ proxy: { ...p, status } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 更新 (重建容器)
app.put('/api/proxies/:id', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    const { target, port, prefix, cookieDomain, cookiePath, rewriteBody, debug, autoRestart } = req.body;
    Object.assign(p, {
      target: target || p.target,
      port: port || p.port,
      prefix: prefix !== undefined ? prefix : p.prefix,
      cookieDomain: cookieDomain !== undefined ? cookieDomain : p.cookieDomain,
      cookiePath: cookiePath !== undefined ? cookiePath : p.cookiePath,
      rewriteBody: rewriteBody !== false,
      debug: debug !== undefined ? !!debug : p.debug,
      autoRestart: autoRestart !== false,
      updatedAt: new Date().toISOString(),
    });
    saveConfig(cfg);
    // 重建容器
    const wasRunning = (await getContainerStatus(p.id)) === 'running';
    await stopProxyContainer(p.id);
    if (wasRunning) {
      await startProxyContainer(p);
    }
    res.json({ proxy: { ...p, status: wasRunning ? 'running' : 'not-created' } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 删除
app.delete('/api/proxies/:id', async (req, res) => {
  try {
    const cfg = loadConfig();
    const idx = cfg.proxies.findIndex(x => x.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '代理不存在' });
    await stopProxyContainer(cfg.proxies[idx].id);
    cfg.proxies.splice(idx, 1);
    saveConfig(cfg);
    res.json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 启动
app.post('/api/proxies/:id/start', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    await startProxyContainer(p);
    res.json({ status: 'running' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 停止
app.post('/api/proxies/:id/stop', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    await stopProxyContainer(p.id);
    res.json({ status: 'stopped' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 重启
app.post('/api/proxies/:id/restart', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    await stopProxyContainer(p.id);
    await startProxyContainer(p);
    res.json({ status: 'running' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 日志
app.get('/api/proxies/:id/logs', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    const tail = parseInt(req.query.tail, 10) || 200;
    const logs = await getContainerLogs(p.id, tail);
    res.json({ logs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 状态
app.get('/api/proxies/:id/status', async (req, res) => {
  try {
    const cfg = loadConfig();
    const p = cfg.proxies.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: '代理不存在' });
    const status = await getContainerStatus(p.id);
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ============================================================
// Bridge API 端点 (调用日志、统计、健康检查等)
// ============================================================

// 调用日志
app.get('/api/bridge/logs', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  res.json({
    logs: bridgeModule.getCallLogs(limit, offset),
    stats: bridgeModule.getCallLogStats(),
  });
});

app.get('/api/bridge/logs/stats', auth, (req, res) => {
  res.json(bridgeModule.getCallLogStats());
});

// 模型使用统计
app.get('/api/bridge/stats/models', auth, (req, res) => {
  res.json({ models: bridgeModule.getModelStats() });
});

// 对话历史
app.get('/api/bridge/conversations', auth, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.search || '';
  res.json(bridgeModule.getConversations(limit, offset, search));
});

app.get('/api/bridge/conversations/:id', auth, (req, res) => {
  const conv = bridgeModule.getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: '对话不存在' });
  res.json(conv);
});

app.delete('/api/bridge/conversations/:id', auth, (req, res) => {
  const deleted = bridgeModule.deleteConversation(req.params.id);
  if (!deleted) return res.status(404).json({ error: '对话不存在' });
  res.json({ deleted: true });
});

// Prompt 模板
app.get('/api/bridge/templates', auth, (req, res) => {
  res.json({ templates: bridgeModule.getTemplates() });
});

app.post('/api/bridge/templates', auth, (req, res) => {
  const { name, prompt, category } = req.body || {};
  if (!name || !prompt) return res.status(400).json({ error: 'name and prompt required' });
  const template = bridgeModule.addTemplate({ name, prompt, category });
  res.json({ template });
});

app.delete('/api/bridge/templates/:id', auth, (req, res) => {
  const deleted = bridgeModule.deleteTemplate(req.params.id);
  if (!deleted) return res.status(404).json({ error: '模板不存在或不可删除' });
  res.json({ deleted: true });
});

// 健康检查 (不需要认证)
app.get('/api/bridge/health', async (req, res) => {
  try {
    const health = await bridgeModule.healthCheck();
    res.json(health);
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// 配置管理
app.get('/api/bridge/config', auth, (req, res) => {
  const config = bridgeModule.getConfig();
  // 不返回完整的 cookie, 只返回是否已配置
  res.json({
    langdockBase: config.langdockBase,
    langdockCookie: config.langdockCookie ? '已配置' : '未配置',
    langdockCookieLength: config.langdockCookie ? config.langdockCookie.length : 0,
    debug: config.debug,
    rateLimit: config.rateLimit,
    maxRetries: config.maxRetries,
    webhookUrl: config.webhookUrl ? '已配置' : '未配置',
    multiAccountCount: config.multiCookies.length,
  });
});

app.put('/api/bridge/config', auth, (req, res) => {
  const newConfig = req.body || {};
  // 验证
  if (newConfig.rateLimit !== undefined && (newConfig.rateLimit < 0 || newConfig.rateLimit > 10000)) {
    return res.status(400).json({ error: 'rateLimit 必须在 0-10000 之间' });
  }
  if (newConfig.maxRetries !== undefined && (newConfig.maxRetries < 1 || newConfig.maxRetries > 10)) {
    return res.status(400).json({ error: 'maxRetries 必须在 1-10 之间' });
  }

  const config = bridgeModule.updateConfig(newConfig);
  res.json({ ok: true, config: {
    langdockBase: config.langdockBase,
    langdockCookie: config.langdockCookie ? '已配置' : '未配置',
    debug: config.debug,
    rateLimit: config.rateLimit,
    maxRetries: config.maxRetries,
  }});
});

// ---------- 启动 ----------
app.listen(PORT, () => {
  console.log(`\nLangdock Proxy Manager 已启动`);
  console.log(`  监听:  http://0.0.0.0:${PORT}`);
  console.log(`  Web UI: http://0.0.0.0:${PORT}/`);
  console.log(`  Token: ${TOKEN}`);
  console.log(`  配置:  ${CONFIG_FILE}`);
  console.log(`  Docker: ${docker ? '已连接' : '不可用'}`);
  console.log('');
});

// 启动时确保所有已配置的代理容器在运行
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
