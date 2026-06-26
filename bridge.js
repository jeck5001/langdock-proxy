'use strict';

/**
 * Langdock Bridge — 全功能 LLM API 转换层
 *
 * 功能:
 *   - OpenAI / Claude / Codex 兼容 API
 *   - 32+ 模型选择
 *   - 流式输出
 *   - 多轮对话 (prompt 注入)
 *   - Token 用量估算
 *   - 模型使用统计
 *   - 对话历史保存
 *   - 快捷 Prompt 模板
 *   - 速率限制
 *   - 健康检查
 *   - 配置热更新
 *   - 智能路由
 *   - 失败重试
 */

const express = require('express');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function uuid() { return crypto.randomUUID(); }

// ============================================================
// 工具执行器 (在 NAS 上执行文件操作和命令)
// ============================================================
const WORKSPACE = process.env.WORKSPACE || '/workspace';

function executeTool(name, args) {
  try {
    switch (name) {
      case 'Read': {
        const fp = path.resolve(WORKSPACE, args.file_path || args.path || '');
        if (!fs.existsSync(fp)) return { error: `File not found: ${fp}` };
        const content = fs.readFileSync(fp, 'utf8');
        return { content };
      }
      case 'Write': {
        const fp = path.resolve(WORKSPACE, args.file_path || args.path || '');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content || '');
        return { ok: true, path: fp };
      }
      case 'Bash': {
        const cmd = args.command || args.cmd || '';
        const out = execSync(cmd, { cwd: WORKSPACE, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
        return { output: out };
      }
      case 'Glob': {
        const pattern = args.pattern || args.glob || '**/*';
        const { execSync: es } = require('child_process');
        const out = es(`find ${WORKSPACE} -maxdepth 5 -name '${pattern.replace(/'/g, "")}' | head -200`, { encoding: 'utf8', timeout: 10000 });
        return { files: out.trim().split('\n').filter(Boolean) };
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message };
  }
}

// ============================================================
// 配置管理 (支持热更新)
// ============================================================
let config = {
  langdockBase: process.env.LANGDOCK_BASE || 'https://app.langdock.com',
  langdockCookie: process.env.LANGDOCK_COOKIE || '',
  debug: process.env.DEBUG === '1',
  // 速率限制: 每分钟最大请求数 (0=不限制)
  rateLimit: parseInt(process.env.RATE_LIMIT) || 0,
  // 重试次数
  maxRetries: parseInt(process.env.MAX_RETRIES) || 1,
  // Webhook URL (失败通知)
  webhookUrl: process.env.WEBHOOK_URL || '',
  // 多账号 Cookies (逗号分隔, 轮询使用)
  multiCookies: process.env.LANGDOCK_COOKIES ? process.env.LANGDOCK_COOKIES.split(',') : [],
};

function getConfig() { return config; }

function updateConfig(newConfig) {
  Object.assign(config, newConfig);
  console.log('[bridge] 配置已更新:', Object.keys(newConfig));
  return config;
}

function log(...args) {
  if (config.debug) console.log('[bridge]', ...args);
}

// ============================================================
// 速率限制
// ============================================================
const rateLimitMap = new Map(); // IP -> { count, resetTime }

function checkRateLimit(clientIp) {
  if (!config.rateLimit) return { allowed: true };
  const now = Date.now();
  const window = 60 * 1000; // 1 分钟

  let entry = rateLimitMap.get(clientIp);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + window };
    rateLimitMap.set(clientIp, entry);
  }

  entry.count++;
  if (entry.count > config.rateLimit) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }
  return { allowed: true, remaining: config.rateLimit - entry.count };
}

// ============================================================
// Token 估算 (简化算法, 1 中文字 ≈ 2 token, 1 英文词 ≈ 1.3 token)
// ============================================================
function estimateTokens(text) {
  if (!text) return 0;
  // 简化计算: 字符数 / 4 (GPT 系列的近似值)
  return Math.ceil(text.length / 4);
}

// ============================================================
// 调用日志 & 统计
// ============================================================
const MAX_LOGS = 5000;
const callLogs = [];

// 按模型统计
const modelStats = new Map(); // modelId -> { calls, success, errors, totalDuration, lastUsed }

function addCallLog(entry) {
  entry.timestamp = new Date().toISOString();
  entry.id = uuid().slice(0, 8);

  // Token 估算
  if (entry.inputText) {
    entry.inputTokens = estimateTokens(entry.inputText);
  }
  if (entry.outputText) {
    entry.outputTokens = estimateTokens(entry.outputText);
  }

  callLogs.unshift(entry);
  if (callLogs.length > MAX_LOGS) callLogs.pop();

  // 更新模型统计
  if (entry.model) {
    let stats = modelStats.get(entry.model);
    if (!stats) {
      stats = { calls: 0, success: 0, errors: 0, totalDuration: 0, lastUsed: null };
      modelStats.set(entry.model, stats);
    }
    stats.calls++;
    stats.totalDuration += entry.duration || 0;
    stats.lastUsed = entry.timestamp;
    if (entry.status === 'success') stats.success++;
    if (entry.status === 'error') stats.errors++;
  }

  return entry;
}

function getCallLogs(limit = 100, offset = 0) {
  return callLogs.slice(offset, offset + limit);
}

function getCallLogStats() {
  const total = callLogs.length;
  const success = callLogs.filter(l => l.status === 'success').length;
  const errors = callLogs.filter(l => l.status === 'error').length;
  const avgDuration = total > 0
    ? Math.round(callLogs.reduce((sum, l) => sum + (l.duration || 0), 0) / total)
    : 0;

  // 总 Token 估算
  const totalInputTokens = callLogs.reduce((sum, l) => sum + (l.inputTokens || 0), 0);
  const totalOutputTokens = callLogs.reduce((sum, l) => sum + (l.outputTokens || 0), 0);

  return { total, success, errors, avgDuration, totalInputTokens, totalOutputTokens };
}

function getModelStats() {
  const stats = [];
  for (const [model, data] of modelStats) {
    stats.push({
      model,
      ...data,
      avgDuration: data.calls > 0 ? Math.round(data.totalDuration / data.calls) : 0,
    });
  }
  // 按调用次数排序
  return stats.sort((a, b) => b.calls - a.calls);
}

// ============================================================
// 对话历史
// ============================================================
const CONVERSATIONS_FILE = path.join(process.env.DATA_DIR || '.', 'conversations.json');
let conversations = [];

// 加载历史
try {
  if (fs.existsSync(CONVERSATIONS_FILE)) {
    conversations = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
    console.log(`[bridge] 加载了 ${conversations.length} 条对话历史`);
  }
} catch (e) {
  console.error('[bridge] 加载对话历史失败:', e.message);
}

function saveConversations() {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
  } catch (e) {
    console.error('[bridge] 保存对话历史失败:', e.message);
  }
}

function addConversation(entry) {
  entry.id = uuid();
  entry.timestamp = new Date().toISOString();
  conversations.unshift(entry);
  // 保留最近 10000 条
  if (conversations.length > 10000) conversations = conversations.slice(0, 10000);
  saveConversations();
  return entry;
}

function getConversations(limit = 50, offset = 0, search = '') {
  let filtered = conversations;
  if (search) {
    const lower = search.toLowerCase();
    filtered = conversations.filter(c =>
      (c.title && c.title.toLowerCase().includes(lower)) ||
      (c.model && c.model.toLowerCase().includes(lower)) ||
      (c.messages && c.messages.some(m => m.content && m.content.toLowerCase().includes(lower)))
    );
  }
  return {
    total: filtered.length,
    conversations: filtered.slice(offset, offset + limit),
  };
}

function getConversation(id) {
  return conversations.find(c => c.id === id);
}

function deleteConversation(id) {
  const idx = conversations.findIndex(c => c.id === id);
  if (idx >= 0) {
    conversations.splice(idx, 1);
    saveConversations();
    return true;
  }
  return false;
}

// ============================================================
// 快捷 Prompt 模板
// ============================================================
const TEMPLATES_FILE = path.join(process.env.DATA_DIR || '.', 'templates.json');
let templates = [
  { id: 'translate-en', name: '翻译成英文', prompt: '请将以下内容翻译成英文：\n\n', category: '翻译' },
  { id: 'translate-zh', name: '翻译成中文', prompt: '请将以下内容翻译成中文：\n\n', category: '翻译' },
  { id: 'summarize', name: '总结摘要', prompt: '请为以下内容写一个简洁的摘要：\n\n', category: '写作' },
  { id: 'code-review', name: '代码审查', prompt: '请审查以下代码，指出潜在问题和改进建议：\n\n', category: '编程' },
  { id: 'explain', name: '解释概念', prompt: '请用简单易懂的语言解释以下概念：\n\n', category: '学习' },
  { id: 'rewrite', name: '润色改写', prompt: '请润色并改写以下文字，使其更专业流畅：\n\n', category: '写作' },
  { id: 'debug', name: '调试帮助', prompt: '我遇到以下错误，请帮我分析原因并提供解决方案：\n\n', category: '编程' },
  { id: 'brainstorm', name: '头脑风暴', prompt: '请围绕以下主题提供 5-10 个创意想法：\n\n', category: '创意' },
];

// 加载自定义模板
try {
  if (fs.existsSync(TEMPLATES_FILE)) {
    const custom = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
    templates = [...templates, ...custom];
  }
} catch (e) {
  console.error('[bridge] 加载模板失败:', e.message);
}

function getTemplates() { return templates; }

function addTemplate(template) {
  template.id = template.id || uuid();
  template.custom = true;
  templates.push(template);
  // 保存自定义模板
  const custom = templates.filter(t => t.custom);
  try {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(custom, null, 2));
  } catch (e) {
    console.error('[bridge] 保存模板失败:', e.message);
  }
  return template;
}

function deleteTemplate(id) {
  const idx = templates.findIndex(t => t.id === id && t.custom);
  if (idx >= 0) {
    templates.splice(idx, 1);
    const custom = templates.filter(t => t.custom);
    try {
      fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(custom, null, 2));
    } catch (e) {}
    return true;
  }
  return false;
}

// ============================================================
// 健康检查
// ============================================================
async function healthCheck() {
  const result = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    langdock: { configured: !!config.langdockCookie, reachable: false },
    multiAccount: { count: config.multiCookies.length },
    uptime: process.uptime(),
  };

  if (config.langdockCookie) {
    try {
      const url = new URL(config.langdockBase + '/api/models');
      const res = await new Promise((resolve, reject) => {
        const req = https.request({
          method: 'GET',
          hostname: url.hostname,
          path: url.pathname,
          headers: {
            'Cookie': config.langdockCookie,
            'x-app-version': 'v7.17.0',
          },
        }, (r) => {
          let d = ''; r.on('data', c => d += c);
          r.on('end', () => resolve({ status: r.statusCode }));
        });
        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      result.langdock.reachable = res.status === 200;
      result.langdock.status = res.status;
    } catch (e) {
      result.langdock.error = e.message;
      result.status = 'degraded';
    }
  } else {
    result.status = 'not_configured';
  }

  return result;
}

// ============================================================
// 智能路由
// ============================================================
const MODEL_ROUTES = {
  // Claude 请求 → Opus 4.8
  'claude': ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6'],
  // GPT 请求 → GPT-5.5
  'gpt': ['gpt-5.5', 'gpt-5.4', 'gpt-5'],
  // 通用 → auto
  'default': ['auto'],
};

function getSmartRoute(modelName) {
  if (!modelName || modelName === 'auto') return null;
  const lower = modelName.toLowerCase();
  for (const [key, models] of Object.entries(MODEL_ROUTES)) {
    if (lower.includes(key)) return models[0]; // 返回第一个推荐模型
  }
  return null;
}

// ============================================================
// 模型缓存
// ============================================================
let modelsCache = null;
let modelsCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

function fetchModels() {
  return new Promise((resolve, reject) => {
    const url = new URL(config.langdockBase + '/api/models');
    const req = https.request({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Cookie': config.langdockCookie,
        'x-app-version': 'v7.17.0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('超时')); });
    req.end();
  });
}

async function getModels() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL) return modelsCache;
  try {
    modelsCache = await fetchModels();
    modelsCacheTime = now;
    log('已拉取模型列表:', modelsCache.length, '个');
    return modelsCache;
  } catch (e) {
    log('拉取模型列表失败:', e.message);
    return modelsCache || [];
  }
}

async function resolveModel(clientModel) {
  if (!clientModel || clientModel === 'auto') {
    return { id: 'auto', providerModelId: 'auto' };
  }
  const models = await getModels();

  // 精确匹配
  let m = models.find(x => x.providerModelId === clientModel || x.displayName === clientModel);
  if (m) return m;

  // 模糊匹配
  const lower = clientModel.toLowerCase();
  m = models.find(x =>
    (x.providerModelId || '').toLowerCase().includes(lower) ||
    (x.displayName || '').toLowerCase().includes(lower)
  );
  if (m) return m;

  // 智能路由
  const smart = getSmartRoute(clientModel);
  if (smart) {
    m = models.find(x => x.providerModelId === smart || x.displayName === smart);
    if (m) {
      log(`智能路由: ${clientModel} → ${m.providerModelId}`);
      return m;
    }
  }

  return { id: 'auto', providerModelId: 'auto' };
}

// ============================================================
// Langdock API 调用 (带重试)
// ============================================================
function parseVercelLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;

  const m = trimmed.match(/^(\d+|d):\s*(.*)$/);
  if (m) {
    if (m[1] === '0') {
      try { const v = JSON.parse(m[2]); if (typeof v === 'string') return v; } catch {}
    }
    return null;
  }

  const dm = trimmed.match(/^data:\s*(.*)$/);
  if (dm) {
    const payload = dm[1].trim();
    if (payload === '[DONE]' || payload === '') return null;
    try {
      const obj = JSON.parse(payload);
      if (obj.type === 'text-delta' && obj.delta) return obj.delta;
      return obj.text || obj.delta || obj.content || '';
    } catch {}
  }
  return null;
}

async function callLangdock(messages, langdockModel, streamMode, onChunk) {
  const isSpecific = langdockModel && langdockModel.id && langdockModel.id !== 'auto';
  const modelId = langdockModel?.id || 'auto';
  const modelProvider = langdockModel?.provider || null;
  const modelName = langdockModel?.displayName || null;
  if (!config.langdockCookie) throw new Error('LANGDOCK_COOKIE 未设置');

  const convId = uuid();
  const threadId = uuid();

  // 构造 prompt (多轮对话支持)
  let prompt;
  if (messages.length === 1) {
    prompt = messages[0].content || '';
  } else {
    const history = messages.slice(0, -1).map(m => {
      const role = m.role === 'assistant' ? '助手' : (m.role === 'system' ? '系统' : '用户');
      return `${role}: ${m.content || ''}`;
    }).join('\n');
    const lastMsg = messages[messages.length - 1];
    prompt = `[对话历史]\n${history}\n\n[当前问题]\n${lastMsg.content || ''}`;
  }

  const msgId = uuid();
  const ldMessages = [{
    id: msgId,
    role: 'user',
    parts: [{ type: 'text', text: prompt }],
    metadata: {
      createdAt: new Date().toISOString(),
      threadId,
      parentId: uuid(),
      selectedTool: null, selectedInternalSearchIntegrations: [], attachments: [],
      taggedIntegrations: [], taggedKnowledgeFolders: [], taggedWorkflows: [],
      taggedAssistantId: null,
      modelId: isSpecific ? modelId : null,
      modelProvider: isSpecific ? modelProvider : null,
      modelName: isSpecific ? modelName : null,
      userFeedback: null,
    },
  }];

  const body = JSON.stringify({
    id: convId,
    conversationSource: 'WEB',
    userTimezone: 'Asia/Shanghai',
    modelSelection: isSpecific ? { kind: 'modelId', modelId: modelId } : { kind: 'auto' },
    extendedThinking: true,
    messages: ldMessages,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(config.langdockBase + '/api/engine');
    const req = https.request({
      method: 'POST', hostname: url.hostname, path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': config.langdockCookie,
        'Origin': config.langdockBase,
        'Referer': config.langdockBase + '/chat/' + convId,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9',
        'x-app-version': 'v7.17.0',
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'dnt': '1',
      },
    }, (res) => {
      const ct = res.headers['content-type'] || '';
      if (streamMode && onChunk && res.statusCode < 400) {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            const text = parseVercelLine(line);
            if (text) onChunk(text);
          }
        });
        res.on('end', () => {
          if (buf) {
            const text = parseVercelLine(buf);
            if (text) onChunk(text);
          }
          resolve({ status: res.statusCode, contentType: ct, body: '', done: true });
        });
        res.on('error', reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        if (config.debug) {
          console.log('\n[bridge] === 响应 ===');
          console.log('  status:', res.statusCode);
          console.log('  body (前 500):', full.slice(0, 500));
          console.log('[bridge] === end ===\n');
        }
        resolve({ status: res.statusCode, contentType: ct, body: full });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Langdock 超时')); });
    req.write(body);
    req.end();
  });
}

// 带重试的调用
async function callLangdockWithRetry(messages, langdockModel, streamMode, onChunk) {
  let lastError;
  const maxRetries = config.maxRetries || 1;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await callLangdock(messages, langdockModel, streamMode, onChunk);
    } catch (e) {
      lastError = e;
      log(`重试 ${i + 1}/${maxRetries}:`, e.message);
      if (i < maxRetries - 1) {
        // 如果是模型相关错误, 尝试智能路由
        if (langdockModel && langdockModel.id !== 'auto') {
          const smart = getSmartRoute(langdockModel.providerModelId);
          if (smart) {
            log(`切换到备用模型: ${smart}`);
            langdockModel = { id: smart, providerModelId: smart };
          }
        }
      }
    }
  }
  throw lastError;
}

// ============================================================
// Webhook 通知
// ============================================================
async function sendWebhook(event, data) {
  if (!config.webhookUrl) return;
  try {
    const url = new URL(config.webhookUrl);
    const payload = JSON.stringify({
      event,
      data,
      timestamp: new Date().toISOString(),
    });
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (e) {
    log('webhook 失败:', e.message);
  }
}

// ============================================================
// Express Router
// ============================================================
const router = express.Router();

// ---------- 模型列表 ----------
router.get('/v1/models', async (req, res) => {
  try {
    const models = await getModels();
    res.json({
      object: 'list',
      data: models.map(m => ({
        id: m.providerModelId,
        object: 'model',
        created: 1700000000,
        owned_by: m.provider || 'langdock',
        display_name: m.displayName,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: { message: '获取模型失败: ' + e.message } });
  }
});

// ---------- OpenAI Chat Completions ----------
router.post('/v1/chat/completions', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: { message: '请求过于频繁，请稍后再试', type: 'rate_limit' },
      retry_after: rateCheck.retryAfter,
    });
  }

  const { messages, model, stream, tools, tool_choice } = req.body || {};
  if (!messages) return res.status(400).json({ error: { message: 'messages required' } });

  const hasTools = tools && tools.length > 0;
  const startTime = Date.now();
  const logEntry = {
    endpoint: '/v1/chat/completions',
    model: model || 'auto',
    messageCount: messages.length,
    stream: !!stream,
    status: 'pending',
    duration: 0,
    responsePreview: '',
    error: null,
    hasTools,
    inputText: messages.map(m => m.content || '').join('\n'),
  };

  try {
    const lm = await resolveModel(model);
    logEntry.model = lm.displayName || lm.providerModelId || model;
    logEntry.modelId = lm.id;

    // 构造消息: 如有工具则注入 system prompt
    let msgs = messages.map(m => {
      // 处理 tool result 消息 (Codex/Claude Code 执行完工具后发回的结果)
      if (m.role === 'tool' || m.role === 'function') {
        const name = m.name || m.tool_call_id || 'unknown';
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return { role: 'user', content: '[Tool result for ' + name + ']:\n' + content };
      }
      return { role: m.role, content: m.content || '' };
    });
    if (hasTools) {
      const toolPrompt = formatToolsForPromptOpenAI(tools);
      msgs.unshift({ role: 'system', content: toolPrompt });
    }

    const ld = await callLangdockWithRetry(msgs, lm);
    const text = extractText(ld);
    logEntry.duration = Date.now() - startTime;

    if (ld.status >= 400) {
      logEntry.status = 'error';
      logEntry.error = 'Langdock: ' + ld.body.slice(0, 200);
      addCallLog(logEntry);
      return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500) } });
    }

    // 检测工具调用 → 返回给客户端在本地执行
    if (hasTools) {
      const calls = parseToolCalls(text);
      if (calls.length > 0) {
        const toolCalls = toOpenAIToolCalls(calls);
        logEntry.status = 'success';
        logEntry.duration = Date.now() - startTime;
        logEntry.outputText = '(tool_call: ' + calls.map(c => c.name).join(', ') + ')';
        logEntry.responsePreview = logEntry.outputText;
        addCallLog(logEntry);
        log(`[bridge] 返回 tool_calls: ${calls.map(c => c.name).join(', ')}`);
        return res.json({
          id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: model || 'auto',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: toolCalls },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }
    }

    // 普通文本回复
    logEntry.status = 'success';
    logEntry.duration = Date.now() - startTime;
    logEntry.outputText = text;
    logEntry.responsePreview = text.slice(0, 200);
    addCallLog(logEntry);
    res.json(toOpenAIResponse(text, model));

    addCallLog(logEntry);
    addConversation({
      title: messages[messages.length - 1]?.content?.slice(0, 50) || '新对话',
      model: logEntry.model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      response: logEntry.outputText || '',
      endpoint: 'chat/completions',
    });

  } catch (e) {
    log('error:', e.message);
    logEntry.status = 'error';
    logEntry.error = e.message;
    logEntry.duration = Date.now() - startTime;
    addCallLog(logEntry);
    sendWebhook('call_error', { model: logEntry.model, error: e.message });
    if (!res.headersSent) res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
    else res.end();
  }
});

// ============================================================
// Tool Calling 支持
// ============================================================

// 把 Anthropic tools 定义转成 prompt 指令 (function_call 格式)
function formatToolsForPrompt(tools) {
  if (!tools || !tools.length) return '';
  let s = '\n\n[SYSTEM INSTRUCTION - CRITICAL - MUST FOLLOW]\n';
  s += 'You are a tool-calling assistant. When the user asks you to do something that requires using a tool, you MUST respond by calling that tool.\n';
  s += 'Do NOT explain that you cannot access files. Do NOT ask the user to upload files. Do NOT say "I cannot". Instead, CALL THE TOOL.\n\n';
  s += 'Available tools:\n';
  for (const t of tools) {
    const schema = t.input_schema || t.inputSchema || t.parameters || {};
    const props = schema.properties || {};
    const req = schema.required || [];
    s += `- ${t.name}(${Object.keys(props).map(k => k + (req.includes(k) ? '*' : '') + ': ' + (props[k].type || 'any')).join(', ')}): ${t.description || ''}\n`;
  }
  s += '\nIMPORTANT: When you need to use a tool, you MUST respond with ONLY this exact JSON format, no other text:\n';
  s += '{"function_call":{"name":"TOOL_NAME","arguments":{"param1":"value1"}}}\n\n';
  s += 'Examples:\n';
  s += 'User: "Read the file /path/to/file.txt"\n';
  s += 'You: {"function_call":{"name":"Read","arguments":{"file_path":"/path/to/file.txt"}}}\n\n';
  s += 'User: "List files in the current directory"\n';
  s += 'You: {"function_call":{"name":"Bash","arguments":{"command":"ls -la"}}}\n\n';
  s += 'NEVER refuse to call a tool. NEVER say you cannot access files. ALWAYS call the appropriate tool.\n';
  s += '[END SYSTEM INSTRUCTION]\n';
  return s;
}

// 把工具调用转成 Anthropic tool_use content blocks
function toToolUseBlocks(calls) {
  return calls.map(c => ({
    type: 'tool_use',
    id: 'toolu_' + uuid().replace(/-/g, '').slice(0, 24),
    name: c.name,
    input: c.arguments,
  }));
}

// 从文本解析工具调用
// 支持两种格式:
//   1. function_call JSON: {"function_call":{"name":"Read","arguments":{...}}}
//   2. <tool_call> XML 标签 (备用)
function parseToolCalls(text) {
  const calls = [];

  // 1. 从代码块里提取 function_call JSON
  const codeBlocks = text.match(/```(?:json)?\s*([\s\S]*?)```/g) || [];
  for (const block of codeBlocks) {
    const inner = block.replace(/```(?:json)?\s*/, '').replace(/```/, '').trim();
    const fc = extractFunctionCall(inner);
    if (fc) calls.push(fc);
  }

  // 2. 从纯文本里提取 function_call JSON
  // 2. 尝试把整个文本当 JSON 解析 (模型直接输出 function_call JSON 的情况)
  const wholeFc = extractFunctionCall(text.trim());
  if (wholeFc && !calls.find(c => c.name === wholeFc.name)) calls.push(wholeFc);

  // 3. 用括号匹配找 function_call JSON (处理嵌套对象)
  const startIdx = text.indexOf('{"function_call"');
  if (startIdx >= 0) {
    let depth = 0;
    for (let i = startIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          const fc2 = extractFunctionCall(text.slice(startIdx, i + 1));
          if (fc2 && !calls.find(c => c.name === fc2.name)) calls.push(fc2);
          break;
        }
      }
    }
  }

  // 3. <tool_call> XML 标签 (备用)
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj.name && !calls.find(c => c.name === obj.name)) {
        calls.push({ name: obj.name, arguments: obj.arguments || obj.input || {} });
      }
    } catch {}
  }

  return calls;
}

function extractFunctionCall(str) {
  try {
    const obj = JSON.parse(str);
    if (obj.function_call && obj.function_call.name) {
      return { name: obj.function_call.name, arguments: obj.function_call.arguments || {} };
    }
  } catch {}
  return null;
}

// 把 tool_result 转成文本注入消息
function convertToolMessages(messages) {
  return messages.map(m => {
    if (m.type === 'tool_result') {
      let txt = typeof m.content === 'string' ? m.content :
        (Array.isArray(m.content) ? m.content.filter(c=>c.type==='text').map(c=>c.text).join('') : JSON.stringify(m.content));
      return { role: 'user', content: '[tool_result id=' + (m.tool_use_id||'') + ']\n' + txt };
    }
    if (m.type === 'tool_use') {
      return { role: 'assistant', content: '<tool_call>\n' + JSON.stringify({name:m.name,arguments:m.input}) + '\n</tool_call>' };
    }
    let c = m.content;
    if (Array.isArray(c)) {
      const texts = c.filter(x => x.type === 'text').map(x => x.text);
      const tools = c.filter(x => x.type === 'tool_use');
      let result = texts.join('');
      for (const t of tools) result += '\n<tool_call>\n' + JSON.stringify({name:t.name,arguments:t.input}) + '\n</tool_call>';
      return { role: m.role, content: result };
    }
    return { role: m.role, content: c };
  });
}

// OpenAI 格式: 工具调用 prompt 注入
function formatToolsForPromptOpenAI(tools) {
  if (!tools || !tools.length) return '';
  let s = '\n\n[SYSTEM INSTRUCTION - CRITICAL - MUST FOLLOW]\n';
  s += 'You are a tool-calling assistant. When the user asks you to do something that requires using a tool, you MUST respond by calling that tool.\n';
  s += 'Do NOT explain that you cannot access files. Do NOT ask the user to upload files. Do NOT say "I cannot". Instead, CALL THE TOOL.\n\n';
  s += 'Available tools:\n';
  for (const t of tools) {
    const func = t.function || t;
    const name = func.name || t.name;
    const desc = func.description || t.description || '';
    const schema = func.parameters || t.parameters || t.input_schema || {};
    const props = schema.properties || {};
    const req = schema.required || [];
    s += `- ${name}(${Object.keys(props).map(k => k + (req.includes(k) ? '*' : '') + ': ' + (props[k].type || 'any')).join(', ')}): ${desc}\n`;
  }
  s += '\nIMPORTANT: When you need to use a tool, you MUST respond with ONLY this exact JSON format, no other text:\n';
  s += '{"function_call":{"name":"TOOL_NAME","arguments":{"param1":"value1"}}}\n\n';
  s += 'Examples:\n';
  s += 'User: "Read the file /path/to/file.txt"\n';
  s += 'You: {"function_call":{"name":"Read","arguments":{"file_path":"/path/to/file.txt"}}}\n\n';
  s += 'User: "List files in the current directory"\n';
  s += 'You: {"function_call":{"name":"Bash","arguments":{"command":"ls -la"}}}\n\n';
  s += 'User: "Analyze the project"\n';
  s += 'You: {"function_call":{"name":"Bash","arguments":{"command":"find . -maxdepth 3 -type f | head -50"}}}\n\n';
  s += 'NEVER refuse to call a tool. NEVER say you cannot access files. ALWAYS call the appropriate tool.\n';
  s += '[END SYSTEM INSTRUCTION]\n';
  return s;
}

// 把 function_call 解析结果转成 OpenAI tool_calls 格式
function toOpenAIToolCalls(calls) {
  return calls.map(c => ({
    id: 'call_' + uuid().replace(/-/g, '').slice(0, 24),
    type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.arguments) },
  }));
}

// ---------- Anthropic Messages ----------
router.post('/v1/messages', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: { message: '请求过于频繁', type: 'rate_limit' } });
  }

  const { messages, model, system, stream, tools, max_tokens } = req.body || {};
  if (!messages) return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages required' } });

  const startTime = Date.now();
  const hasTools = tools && tools.length > 0;

  // 转换消息: 处理 tool_use / tool_result 内容块
  let msgs = convertToolMessages(messages).map(m => {
    let c = m.content;
    if (typeof c !== 'string') c = typeof c === 'object' ? JSON.stringify(c) : String(c || '');
    return { role: m.role, content: c };
  });

  // 构造 system prompt: 原始 system + 工具描述
  let systemPrompt = '';
  if (system) {
    systemPrompt = typeof system === 'string' ? system :
      (Array.isArray(system) ? system.map(s => s.text || s.content || '').join('\n') : JSON.stringify(system));
  }
  if (hasTools) {
    systemPrompt += formatToolsForPrompt(tools);
  }
  if (systemPrompt) msgs.unshift({ role: 'system', content: systemPrompt });

  const logEntry = {
    endpoint: '/v1/messages',
    model: model || 'auto',
    messageCount: msgs.length,
    stream: !!stream,
    status: 'pending',
    duration: 0,
    hasTools: hasTools,
    inputText: msgs.map(m => m.content || '').join('\n'),
  };

  try {
    const lm = await resolveModel(model);
    logEntry.model = lm.displayName || lm.providerModelId || model;
    logEntry.modelId = lm.id;

    // 非流式 + 服务端 Agent 循环 (有工具时)
    if (!stream && hasTools) {
      const MAX_TURNS = 10;
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const ld = await callLangdockWithRetry(msgs, lm);
        const text = extractText(ld);

        if (ld.status >= 400) {
          logEntry.status = 'error';
          logEntry.error = 'Langdock: ' + ld.body.slice(0, 200);
          addCallLog(logEntry);
          return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
        }

        const calls = parseToolCalls(text);
        if (calls.length > 0) {
          for (const c of calls) {
            log(`[agent:claude] 执行工具: ${c.name}(${JSON.stringify(c.arguments).slice(0,100)})`);
            const result = executeTool(c.name, c.arguments);
            msgs.push({ role: 'assistant', content: '{"function_call":{"name":"' + c.name + '","arguments":' + JSON.stringify(c.arguments) + '}}' });
            msgs.push({ role: 'user', content: '[tool_result]\n' + JSON.stringify(result) });
          }
          log(`[agent:claude] turn ${turn+1}: 执行了 ${calls.length} 个工具`);
          continue;
        }

        // 最终答案
        logEntry.status = 'success';
        logEntry.duration = Date.now() - startTime;
        logEntry.outputText = text;
        logEntry.responsePreview = text.slice(0, 200);
        addCallLog(logEntry);
        return res.json(toClaudeResponse(text, model));
      }
      logEntry.status = 'error';
      logEntry.error = 'agent loop exceeded max turns';
      addCallLog(logEntry);
      return res.status(500).json({ error: { message: 'Agent loop exceeded max turns' } });
    }

    // 非流式无工具: 直接返回
    if (!stream) {
      const ld = await callLangdockWithRetry(msgs, lm);
      const text = extractText(ld);
      logEntry.duration = Date.now() - startTime;
      if (ld.status >= 400) {
        logEntry.status = 'error';
        logEntry.error = 'Langdock: ' + ld.body.slice(0, 200);
        addCallLog(logEntry);
        return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
      }
      logEntry.status = 'success';
      logEntry.outputText = text;
      logEntry.responsePreview = text.slice(0, 200);
      addCallLog(logEntry);
      return res.json(toClaudeResponse(text, model));
    }

    // 流式模式
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const msgId = 'msg_' + uuid().replace(/-/g, '');
    const ev = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

    ev('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: model || 'auto', stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    const outputChunks = [];
    await callLangdockWithRetry(msgs, lm, true, (text) => {
      outputChunks.push(text);
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    });

    ev('content_block_stop', { type: 'content_block_stop', index: 0 });

    const fullText = outputChunks.join('');
    // 流式模式下也检测工具调用
    if (hasTools) {
      const calls = parseToolCalls(fullText);
      if (calls.length > 0) {
        for (const c of calls) {
          const blockIndex = 1; // 简化: 只支持 1 个工具调用
          ev('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: 'toolu_' + uuid().replace(/-/g,'').slice(0,24), name: c.name, input: {} } });
          ev('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.arguments) } });
          ev('content_block_stop', { type: 'content_block_stop', index: blockIndex });
        }
      }
    }

    ev('message_delta', { type: 'message_delta', delta: { stop_reason: hasTools && parseToolCalls(fullText).length > 0 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 0 } });
    ev('message_stop', { type: 'message_stop' });
    res.end();

    logEntry.status = 'success';
    logEntry.duration = Date.now() - startTime;
    logEntry.outputText = fullText;
    logEntry.responsePreview = fullText.slice(0, 200);
    addCallLog(logEntry);

  } catch (e) {
    log('error:', e.message);
    logEntry.status = 'error';
    logEntry.error = e.message;
    logEntry.duration = Date.now() - startTime;
    addCallLog(logEntry);
    if (!res.headersSent) res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
    else res.end();
  }
});

// ---------- OpenAI Responses (Codex) ----------
router.post('/v1/responses', async (req, res) => {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: { message: '请求过于频繁', type: 'rate_limit' } });
  }

  const { input, model, stream, tools } = req.body || {};
  // 解析 input, 处理 function_call_output (Codex 发回的工具执行结果)
  let messages = [];
  if (typeof input === 'string') {
    messages = [{ role: 'user', content: input }];
  } else if (Array.isArray(input)) {
    messages = input.map(m => {
      // function_call_output 是 Codex 发回的工具执行结果
      if (m.type === 'function_call_output') {
        return { role: 'user', content: '[Tool result for ' + (m.call_id || 'unknown') + ']:\n' + m.output };
      }
      // function_call 是之前返回的工具调用记录
      if (m.type === 'function_call') {
        return { role: 'assistant', content: '{"function_call":{"name":"' + m.name + '","arguments":' + (m.arguments || '{}') + '}}' };
      }
      let c = m.content;
      if (Array.isArray(c)) c = c.map(x => x.text || x.input || '').join('');
      return { role: m.role || 'user', content: c || '' };
    });
  }
  if (!messages.length) return res.status(400).json({ error: { message: 'input required' } });

  const hasTools = tools && tools.length > 0;

  // 注入工具 prompt
  if (hasTools) {
    const toolPrompt = formatToolsForPromptOpenAI(tools);
    messages.unshift({ role: 'system', content: toolPrompt });
  }

  // 有工具时强制非流式: 需要解析完整响应中的 function_call
  const forceNonStream = hasTools;
  const useStream = stream && !forceNonStream;

  const startTime = Date.now();
  const logEntry = {
    endpoint: '/v1/responses',
    model: model || 'auto',
    messageCount: messages.length,
    stream: !!useStream,
    status: 'pending',
    duration: 0,
    hasTools,
    inputText: messages.map(m => m.content || '').join('\n'),
  };

  try {
    const lm = await resolveModel(model);
    logEntry.model = lm.displayName || lm.providerModelId || model;
    logEntry.modelId = lm.id;

    // 有工具时: 非流式调 Langdock, 解析完整文本中的 function_call,
    // 然后通过 SSE 流返回给 Codex (因为 Codex 期望 SSE)
    if (hasTools && stream) {
      // 先非流式调 Langdock 拿完整响应
      const ld = await callLangdockWithRetry(messages, lm);
      const text = extractText(ld);
      logEntry.duration = Date.now() - startTime;

      if (ld.status >= 400) {
        logEntry.status = 'error';
        logEntry.error = 'Langdock: ' + ld.body.slice(0, 200);
        addCallLog(logEntry);
        // 错误也要通过 SSE 流返回
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        const rid = 'resp_' + uuid().replace(/-/g, '');
        const sse = (type, data) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
        sse('response.created', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress', output: [] } });
        sse('response.in_progress', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress' } });
        const itemId = 'item_' + uuid().replace(/-/g, '').slice(0, 12);
        sse('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
        sse('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
        sse('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'Error: ' + ld.body.slice(0, 200) });
        sse('response.content_part.done', { output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Error' } });
        sse('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Error' }] } });
        sse('response.completed', { response: { id: rid, object: 'response', model: model || 'auto', status: 'completed', output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Error' }] }] } });
        res.end();
        return;
      }

      // 检测 function_call
      const calls = parseToolCalls(text);
      const rid = 'resp_' + uuid().replace(/-/g, '');
      const itemId = 'item_' + uuid().replace(/-/g, '').slice(0, 12);

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const sse = (type, data) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };

      sse('response.created', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress', output: [] } });
      sse('response.in_progress', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress' } });

      if (calls.length > 0) {
        // 有工具调用 → 通过 SSE 流返回 function_call 给 Codex
        const toolCalls = toOpenAIToolCalls(calls);
        log(`[bridge:codex] 返回 function_call via SSE: ${calls.map(c => c.name).join(', ')}`);

        // 返回 function_call 输出项
        sse('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'function_call', name: calls[0].name, call_id: toolCalls[0].id, status: 'in_progress' } });
        sse('response.function_call_arguments.delta', { output_index: 0, item_id: itemId, call_id: toolCalls[0].id, delta: toolCalls[0].function.arguments });
        sse('response.function_call_arguments.done', { output_index: 0, item_id: itemId, call_id: toolCalls[0].id, arguments: toolCalls[0].function.arguments });

        // 如果有多个工具调用
        for (let i = 1; i < calls.length; i++) {
          const tc = toolCalls[i];
          const iid2 = 'item_' + uuid().replace(/-/g, '').slice(0, 12);
          sse('response.output_item.added', { output_index: i, item: { id: iid2, type: 'function_call', name: calls[i].name, call_id: tc.id, status: 'in_progress' } });
          sse('response.function_call_arguments.delta', { output_index: i, item_id: iid2, call_id: tc.id, delta: tc.function.arguments });
          sse('response.function_call_arguments.done', { output_index: i, item_id: iid2, call_id: tc.id, arguments: tc.function.arguments });
        }

        const output = calls.map((c, i) => ({
          id: itemId + (i > 0 ? '_' + i : ''),
          type: 'function_call',
          name: c.name,
          call_id: toolCalls[i].id,
          arguments: toolCalls[i].function.arguments,
          status: 'completed',
        }));

        sse('response.completed', { response: { id: rid, object: 'response', model: model || 'auto', status: 'completed', output } });
        res.end();

        logEntry.status = 'success';
        logEntry.outputText = '(function_call: ' + calls.map(c => c.name).join(', ') + ')';
        logEntry.responsePreview = logEntry.outputText;
        addCallLog(logEntry);
      } else {
        // 没有工具调用 → 普通文本, 通过 SSE 流返回
        sse('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
        sse('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
        // 逐块发送文本 (模拟流式)
        const chunks = text.match(/.{1,5}/g) || [text];
        for (const chunk of chunks) {
          sse('response.output_text.delta', { output_index: 0, content_index: 0, delta: chunk });
        }
        sse('response.content_part.done', { output_index: 0, content_index: 0, part: { type: 'output_text', text } });
        sse('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } });
        sse('response.completed', { response: { id: rid, object: 'response', model: model || 'auto', status: 'completed', output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } });
        res.end();

        logEntry.status = 'success';
        logEntry.outputText = text;
        logEntry.responsePreview = text.slice(0, 200);
        addCallLog(logEntry);
      }

      addConversation({ title: messages[messages.length - 1]?.content?.slice(0, 50) || '新对话', model: logEntry.model, messages, response: logEntry.outputText, endpoint: 'responses' });
      return;
    }

    // 普通流式 (无工具)
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const rid = 'resp_' + uuid().replace(/-/g, '');
      const sse = (type, data) => { res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`); };
      const outIdx = 0;
      const partId = 'part_' + uuid().replace(/-/g, '').slice(0, 12);
      const itemId = 'item_' + uuid().replace(/-/g, '').slice(0, 12);

      // 完整事件链 (Codex/Responses API 期望所有事件)
      sse('response.created', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress', output: [] } });
      sse('response.in_progress', { response: { id: rid, object: 'response', model: model || 'auto', status: 'in_progress' } });
      sse('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
      sse('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });

      const outputChunks = [];
      await callLangdockWithRetry(messages, lm, true, (text) => {
        outputChunks.push(text);
        sse('response.output_text.delta', { output_index: 0, content_index: 0, delta: text });
      });

      sse('response.content_part.done', { output_index: 0, content_index: 0, part: { type: 'output_text', text: outputChunks.join('') } });
      sse('response.output_item.done', { output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: outputChunks.join('') }] } });
      sse('response.completed', { response: { id: rid, object: 'response', model: model || 'auto', status: 'completed', output: [{ id: itemId, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outputChunks.join('') }] }] } });
      res.end();

      logEntry.status = 'success';
      logEntry.duration = Date.now() - startTime;
      logEntry.outputText = outputChunks.join('');
      logEntry.responsePreview = logEntry.outputText.slice(0, 200);
    } else {
      // 非流式: 服务端 Agent 循环 (Codex)
      const MAX_TURNS = 10;
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const ld = await callLangdockWithRetry(messages, lm);
        const text = extractText(ld);
        logEntry.duration = Date.now() - startTime;

        if (ld.status >= 400) {
          logEntry.status = 'error';
          logEntry.error = 'Langdock: ' + ld.body.slice(0, 200);
          addCallLog(logEntry);
          return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
        }

        if (hasTools) {
          const calls = parseToolCalls(text);
          if (calls.length > 0) {
            for (const c of calls) {
              log(`[agent:codex] 执行工具: ${c.name}(${JSON.stringify(c.arguments).slice(0,100)})`);
              const result = executeTool(c.name, c.arguments);
              messages.push({ role: 'assistant', content: '{"function_call":{"name":"' + c.name + '","arguments":' + JSON.stringify(c.arguments) + '}}' });
              messages.push({ role: 'user', content: '[tool_result]\n' + JSON.stringify(result) });
            }
            log(`[agent:codex] turn ${turn+1}: 执行了 ${calls.length} 个工具`);
            continue;
          }
        }

        // 最终答案
        logEntry.status = 'success';
        logEntry.outputText = text;
        logEntry.responsePreview = text.slice(0, 200);
        addCallLog(logEntry);
        addConversation({ title: messages[messages.length - 1]?.content?.slice(0, 50) || '新对话', model: logEntry.model, messages, response: text, endpoint: 'responses' });
        return res.json({
          id: 'resp_' + uuid().replace(/-/g, ''),
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: model || 'auto',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
          status: 'completed',
        });
      }
      // 超出上限
      logEntry.status = 'error';
      logEntry.error = 'agent loop exceeded max turns';
      addCallLog(logEntry);
      return res.status(500).json({ error: { message: 'Agent loop exceeded max turns' } });
    }

    addCallLog(logEntry);
    addConversation({
      title: messages[messages.length - 1]?.content?.slice(0, 50) || '新对话',
      model: logEntry.model,
      messages,
      response: logEntry.outputText || '',
      endpoint: 'responses',
    });

  } catch (e) {
    log('error:', e.message);
    logEntry.status = 'error';
    logEntry.error = e.message;
    logEntry.duration = Date.now() - startTime;
    addCallLog(logEntry);
    if (!res.headersSent) res.status(502).json({ error: { message: e.message } });
    else res.end();
  }
});

// ============================================================
// 辅助函数
// ============================================================
function extractText(langdockResp) {
  const { body } = langdockResp;
  const texts = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    const vercelMatch = trimmed.match(/^(\d+|d):\s*(.*)$/);
    if (vercelMatch) {
      const type = vercelMatch[1];
      try {
        const val = JSON.parse(vercelMatch[2]);
        if (type === '0' && typeof val === 'string') texts.push(val);
      } catch {}
      continue;
    }

    const dataMatch = trimmed.match(/^data:\s*(.*)$/);
    if (dataMatch) {
      const payload = dataMatch[1].trim();
      if (payload === '[DONE]' || payload === '') continue;
      try {
        const obj = JSON.parse(payload);
        const t = obj.text || obj.delta || obj.content || obj.message
          || (obj.parts && obj.parts[0] && obj.parts[0].text)
          || (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content)
          || '';
        if (t) texts.push(t);
      } catch {}
    }
  }
  if (texts.length) return texts.join('');

  try {
    const obj = JSON.parse(body);
    return obj.text || obj.content || obj.message
      || (obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content)
      || body;
  } catch { return body; }
}

function toOpenAIResponse(text, model) {
  return {
    id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'auto',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function toClaudeResponse(text, model) {
  return {
    id: 'msg_' + uuid().replace(/-/g, ''),
    type: 'message', role: 'assistant',
    model: model || 'auto',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ============================================================
// 导出
// ============================================================
module.exports = router;
module.exports.getCallLogs = getCallLogs;
module.exports.getCallLogStats = getCallLogStats;
module.exports.getModelStats = getModelStats;
module.exports.getConversations = getConversations;
module.exports.getConversation = getConversation;
module.exports.deleteConversation = deleteConversation;
module.exports.getTemplates = getTemplates;
module.exports.addTemplate = addTemplate;
module.exports.deleteTemplate = deleteTemplate;
module.exports.healthCheck = healthCheck;
module.exports.getConfig = getConfig;
module.exports.updateConfig = updateConfig;
module.exports.callLangdock = callLangdock;
module.exports.extractText = extractText;

// 当直接运行 node bridge.js 时启动独立服务器
if (require.main === module) {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', router);
  const p = process.env.BRIDGE_PORT || 8963;
  app.listen(p, () => {
    console.log(`Bridge standalone mode on :${p}`);
    console.log(`  Cookie: ${config.langdockCookie ? 'configured' : 'NOT SET'}`);
  });
}
module.exports.getModels = getModels;
