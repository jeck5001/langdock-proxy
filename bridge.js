'use strict';

/**
 * Bridge 路由模块 — 把 Langdock 账号转成 OpenAI/Claude/Codex 兼容 API
 * 导出一个 Express router, 挂到 manager 的 /v1/* 路径
 *
 * 路由:
 *   POST /v1/chat/completions   OpenAI Chat
 *   POST /v1/messages           Anthropic Claude
 *   POST /v1/responses          OpenAI Responses (Codex)
 *   GET  /v1/models             模型列表 (从 Langdock /api/models 动态拉取)
 */

const express = require('express');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }

// ---------- 配置 ----------
const LANGDOCK_BASE = process.env.LANGDOCK_BASE || 'https://app.langdock.com';
const LANGDOCK_COOKIE = process.env.LANGDOCK_COOKIE || '';
const DEBUG = process.env.DEBUG === '1';

function log(...args) {
  if (DEBUG) console.log('[bridge]', ...args);
}

// ---------- 模型缓存 ----------
// 从 Langdock /api/models 拉取, 缓存 10 分钟
let modelsCache = null;
let modelsCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000;

// Langdock 模型 ID (UUID) → providerModelId (如 "claude-opus-4-8") 的映射
// 客户端传的 model 名要匹配 providerModelId 或 displayName
function fetchModels() {
  return new Promise((resolve, reject) => {
    const url = new URL(LANGDOCK_BASE + '/api/models');
    const req = https.request({
      method: 'GET',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Cookie': LANGDOCK_COOKIE,
        'x-app-version': 'v7.17.0',
        'Accept': '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const arr = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(arr);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('models 超时')); });
    req.end();
  });
}

async function getModels() {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL) {
    return modelsCache;
  }
  try {
    const arr = await fetchModels();
    modelsCache = arr;
    modelsCacheTime = now;
    log('已拉取模型列表:', arr.length, '个');
    return arr;
  } catch (e) {
    log('拉取模型列表失败:', e.message);
    // 返回缓存 (即使过期) 或空
    return modelsCache || [];
  }
}

// 客户端传的 model 名 → Langdock 模型对象
// 匹配顺序: providerModelId 完全匹配 → displayName 匹配 → provider 匹配 → 默认 auto
async function resolveModel(clientModel) {
  if (!clientModel || clientModel === 'auto' || clientModel === 'langdock-auto') {
    return { modelId: 'auto', providerModelId: 'auto' };
  }
  const models = await getModels();
  // 1) providerModelId 匹配 (如 "claude-opus-4-8", "gpt-5.5")
  let m = models.find(x => x.providerModelId === clientModel);
  if (m) return m;
  // 2) displayName 匹配 (如 "Opus 4.8")
  m = models.find(x => x.displayName === clientModel);
  if (m) return m;
  // 3) 模糊匹配: clientModel 包含在 providerModelId 或 displayName 里
  //    如 "opus" → 找到第一个含 opus 的
  const lower = clientModel.toLowerCase();
  m = models.find(x =>
    (x.providerModelId || '').toLowerCase().includes(lower) ||
    (x.displayName || '').toLowerCase().includes(lower)
  );
  if (m) return m;
  // 4) 兜底: auto
  log('未找到模型:', clientModel, '→ 用 auto');
  return { modelId: 'auto', providerModelId: 'auto' };
}

// ---------- 会话粘合 ----------
// OpenAI/Claude API 是无状态的 (客户端每次发完整 messages),
// 但 Langdock 是有状态的 (会话 ID 维护上下文).
// 我们用消息内容哈希做 sessionKey, 同一对话复用同一个 Langdock 会话.
//
// 映射: sessionKey → { convId, lastMsgId, msgCount }
const sessions = new Map();
// 清理超过 2 小时没活动的会话, 避免内存泄漏
const SESSION_TTL = 2 * 60 * 60 * 1000;

function sessionKey(messages) {
  // 用第一条 user 消息的内容做 key (跳过 system, 因为 system 可能变化或每次相同)
  // 同一对话的第一条 user 不会变, 后续请求都能匹配
  const firstUser = messages.find(m => m.role === 'user') || messages[0];
  const firstContent = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content || '');
  return crypto.createHash('sha256').update('user::' + firstContent).digest('hex').slice(0, 16);
}

function getSession(key) {
  const s = sessions.get(key);
  if (s && (Date.now() - s.lastActive) < SESSION_TTL) return s;
  return null;
}

function setSession(key, convId, lastMsgId, msgCount) {
  sessions.set(key, { convId, lastMsgId, msgCount, lastActive: Date.now() });
}

// 清理过期会话 (每次调用时顺便检查)
function cleanSessions() {
  const now = Date.now();
  for (const [k, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL) sessions.delete(k);
  }
}

// ---------- 解析单行 Vercel AI SDK SSE → 文本 ----------
// Langdock 流式格式: 每行 0:"text chunk" 或 d:{"finishReason":"stop"}
function parseVercelLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;

  // Vercel AI SDK: 0:"text" / d:{...}
  const m = trimmed.match(/^(\d+|d):\s*(.*)$/);
  if (m) {
    if (m[1] === '0') {
      try { const v = JSON.parse(m[2]); if (typeof v === 'string') return v; } catch {}
    }
    return null;
  }

  // 传统 SSE: data: {...}
  const dm = trimmed.match(/^data:\s*(.*)$/);
  if (dm) {
    const payload = dm[1].trim();
    if (payload === '[DONE]' || payload === '') return null;
    try {
      const obj = JSON.parse(payload);
      return obj.text || obj.delta || obj.content || '';
    } catch {}
  }
  return null;
}

// ---------- 调 Langdock /api/engine ----------
// streamMode=true + onChunk: 流式, 逐块回调
// 否则: 收集完整响应
async function callLangdock(messages, langdockModel, streamMode, onChunk) {
  // langdockModel = { id, providerModelId, provider, displayName } 从 resolveModel 来
  // 指定模型: modelSelection = { kind: "modelId", modelId: <uuid> }
  // auto: modelSelection = { kind: "auto" }
  const isSpecific = langdockModel && langdockModel.id && langdockModel.id !== 'auto';
  const modelId = langdockModel?.id || 'auto';
  const modelProvider = langdockModel?.provider || null;
  const modelName = langdockModel?.displayName || null;

  cleanSessions();
  const key = sessionKey(messages);
  const existing = getSession(key);

  // 会话粘合逻辑:
  //   - 新会话: 发全部 messages
  //   - 已有会话: 只发最后一条新消息, parentId 指向上次的 lastMsgId
  //   - 如果已有会话但消息数没增加 (重发), 还是发全部
  let convId, parentId, msgToSend;

  if (existing && messages.length > existing.msgCount) {
    // 续接: 复用 convId, 只发新消息
    convId = existing.convId;
    parentId = existing.lastMsgId;
    msgToSend = [messages[messages.length - 1]]; // 只发最后一条
    log(`续接会话 ${convId.slice(0,8)}, parentId=${parentId.slice(0,8)}, 发 ${msgToSend.length} 条新消息`);
  } else {
    // 新会话或重发: 全新 convId, 发全部
    convId = uuid();
    parentId = uuid();
    msgToSend = messages;
    log(`新会话 ${convId.slice(0,8)}, 发 ${msgToSend.length} 条消息`);
  }

  return new Promise((resolve, reject) => {
    if (!LANGDOCK_COOKIE) return reject(new Error('LANGDOCK_COOKIE 未设置'));

    const url = new URL(LANGDOCK_BASE + '/api/engine');
    const threadId = convId; // threadId = convId, 保持一致

    const ldMessages = msgToSend.map((m, i) => {
      const isLast = i === msgToSend.length - 1;
      const msgId = uuid();
      return {
        id: msgId,
        role: m.role === 'system' ? 'user' : m.role,
        parts: [{ type: 'text', text: m.content || '' }],
        metadata: isLast ? {
          createdAt: new Date().toISOString(),
          threadId, parentId,
          selectedTool: null,
          selectedInternalSearchIntegrations: [],
          attachments: [],
          taggedIntegrations: [],
          taggedKnowledgeFolders: [],
          taggedWorkflows: [],
          taggedAssistantId: null,
          modelId: isSpecific ? modelId : null,
          modelProvider: isSpecific ? modelProvider : null,
          modelName: isSpecific ? modelName : null,
          userFeedback: null,
        } : {
          createdAt: new Date().toISOString(),
          threadId, parentId,
        },
      };
    });

    // 记下最后一条消息的 id, 用于下次续接
    const lastMsgId = ldMessages[ldMessages.length - 1].id;

    const body = JSON.stringify({
      id: convId,
      conversationSource: 'WEB',
      userTimezone: 'Asia/Shanghai',
      // 指定模型: kind=modelId + modelId=<uuid>; auto: kind=auto
      modelSelection: isSpecific
        ? { kind: 'modelId', modelId: modelId }
        : { kind: 'auto' },
      extendedThinking: true,
      messages: ldMessages,
    });

    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Cookie': LANGDOCK_COOKIE,
        'Origin': LANGDOCK_BASE,
        'Referer': LANGDOCK_BASE + '/chat/' + convId,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'x-app-version': 'v7.17.0',
        'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'dnt': '1',
      },
    }, (res) => {
      const ct = res.headers['content-type'] || '';

      // 流式模式: 逐行解析 Langdock SSE, 通过 onChunk 回调转发给客户端
      if (streamMode && onChunk && res.statusCode < 400) {
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          // 按行处理 (SSE 每行一个事件)
          const lines = buf.split('\n');
          buf = lines.pop(); // 最后一行可能不完整, 留着
          for (const line of lines) {
            const text = parseVercelLine(line);
            if (text) onChunk(text);
          }
        });
        res.on('end', () => {
          // 处理剩余
          if (buf) {
            const text = parseVercelLine(buf);
            if (text) onChunk(text);
          }
          if (res.statusCode < 400) setSession(key, convId, lastMsgId, messages.length);
          resolve({ status: res.statusCode, contentType: ct, body: '', done: true });
        });
        res.on('error', reject);
        return;
      }

      // 非流式: 收集完整响应
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        if (DEBUG) {
          console.log('\n[bridge] === Langdock 响应 ===');
          console.log('  status:', res.statusCode, 'ct:', ct);
          console.log('  body (前 800):', full.slice(0, 800));
          console.log('[bridge] === end ===\n');
        }
        if (res.statusCode < 400) {
          setSession(key, convId, lastMsgId, messages.length);
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

// ---------- 解析 Langdock 响应 (Vercel AI SDK SSE) → 纯文本 ----------
function extractText(langdockResp) {
  const { body } = langdockResp;
  const texts = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    // Vercel AI SDK: 0:"text" / d:{...}
    const vercelMatch = trimmed.match(/^(\d+|d):\s*(.*)$/);
    if (vercelMatch) {
      const type = vercelMatch[1];
      try {
        const val = JSON.parse(vercelMatch[2]);
        if (type === '0' && typeof val === 'string') texts.push(val);
      } catch {}
      continue;
    }

    // 传统 SSE: data: {...}
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

// ---------- 响应构造 ----------
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

function toOpenAIStream(text, model, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  const mk = (delta, fr) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'auto', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
  res.write(mk({ role: 'assistant' }, null));
  res.write(mk({ content: text }, null));
  res.write(mk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
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

// ---------- Express Router ----------
const router = express.Router();

// 模型列表 (动态从 Langdock 拉取)
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
    res.status(500).json({ error: { message: 'Failed to fetch models: ' + e.message } });
  }
});

// OpenAI Chat Completions
router.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream } = req.body || {};
  if (!messages) return res.status(400).json({ error: { message: 'messages required' } });
  try {
    const lm = await resolveModel(model);
    log(`/v1/chat/completions model=${model} → ${lm.providerModelId} msgs=${messages.length} stream=${stream}`);

    if (stream) {
      // 流式: 逐块转发
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);
      const created = Math.floor(Date.now() / 1000);
      const mk = (delta, fr) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'auto', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
      // role chunk
      res.write(mk({ role: 'assistant' }, null));
      // 逐块转发 Langdock 的 text
      await callLangdock(messages, lm, true, (text) => {
        res.write(mk({ content: text }, null));
      });
      // 结束
      res.write(mk({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const ld = await callLangdock(messages, lm);
      const text = extractText(ld);
      if (ld.status >= 400) return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
      res.json(toOpenAIResponse(text, model));
    }
  } catch (e) {
    log('error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
    else res.end();
  }
});

// Anthropic Messages
router.post('/v1/messages', async (req, res) => {
  const { messages, model, system, stream } = req.body || {};
  if (!messages) return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages required' } });
  let msgs = (messages || []).map(m => {
    let c = m.content;
    if (Array.isArray(c)) c = c.filter(x => x.type === 'text').map(x => x.text).join('');
    return { role: m.role, content: c };
  });
  if (system) msgs.unshift({ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) });
  try {
    const lm = await resolveModel(model);
    log(`/v1/messages model=${model} → ${lm.providerModelId} msgs=${msgs.length} stream=${stream}`);
    const msgId = 'msg_' + uuid().replace(/-/g, '');

    if (stream) {
      // Anthropic SSE 流式
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // message_start
      ev('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: model || 'auto', stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      // content_block_start
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      // 逐块 delta
      await callLangdock(msgs, lm, true, (text) => {
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      });
      // 结束
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      const ld = await callLangdock(msgs, lm);
      const text = extractText(ld);
      if (ld.status >= 400) return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
      res.json(toClaudeResponse(text, model));
    }
  } catch (e) {
    log('error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
    else res.end();
  }
});

// OpenAI Responses (Codex)
router.post('/v1/responses', async (req, res) => {
  const { input, model } = req.body || {};
  let messages = [];
  if (typeof input === 'string') messages = [{ role: 'user', content: input }];
  else if (Array.isArray(input)) messages = input.map(m => {
    let c = m.content;
    if (Array.isArray(c)) c = c.map(x => x.text || '').join('');
    return { role: m.role || 'user', content: c };
  });
  try {
    const lm = await resolveModel(model);
    log(`/v1/responses model=${model} → ${lm.providerModelId} msgs=${messages.length}`);
    const ld = await callLangdock(messages, lm);
    const text = extractText(ld);
    res.json({
      id: 'resp_' + uuid().replace(/-/g, ''),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: model || 'auto',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      status: 'completed',
    });
  } catch (e) {
    res.status(502).json({ error: { message: e.message } });
  }
});

module.exports = router;
module.exports.callLangdock = callLangdock;
module.exports.extractText = extractText;
module.exports.getModels = getModels;
