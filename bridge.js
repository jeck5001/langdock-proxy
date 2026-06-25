'use strict';

/**
 * Bridge 路由模块 — 把 Langdock 账号转成 OpenAI/Claude/Codex 兼容 API
 * 导出一个 Express router, 挂到 manager 的 /v1/* 路径
 *
 * 路由:
 *   POST /v1/chat/completions   OpenAI Chat
 *   POST /v1/messages           Anthropic Claude
 *   POST /v1/responses          OpenAI Responses (Codex)
 *   GET  /v1/models             模型列表
 */

const express = require('express');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

function uuid() { return crypto.randomUUID(); }

// ---------- 配置 (从环境变量读) ----------
const LANGDOCK_BASE = process.env.LANGDOCK_BASE || 'https://app.langdock.com';
const LANGDOCK_COOKIE = process.env.LANGDOCK_COOKIE || '';
const DEBUG = process.env.DEBUG === '1';

function log(...args) {
  if (DEBUG) console.log('[bridge]', ...args);
}

// ---------- 调 Langdock /api/engine ----------
function callLangdock(messages, modelSelection) {
  return new Promise((resolve, reject) => {
    if (!LANGDOCK_COOKIE) return reject(new Error('LANGDOCK_COOKIE 未设置'));

    const url = new URL(LANGDOCK_BASE + '/api/engine');
    const threadId = uuid();
    const parentId = uuid();

    const ldMessages = messages.map((m, i) => {
      const isLast = i === messages.length - 1;
      return {
        id: uuid(),
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
          modelId: modelSelection || 'auto',
          modelProvider: null, modelName: null, userFeedback: null, autoModelTier: 'auto',
        } : {
          createdAt: new Date().toISOString(),
          threadId, parentId,
        },
      };
    });

    const convId = uuid();
    const body = JSON.stringify({
      id: convId,
      conversationSource: 'WEB',
      userTimezone: 'Asia/Shanghai',
      // Langdock 的 kind 只接受 'auto'; 指定模型应该通过 metadata.modelId
      // 目前统一用 auto, 让 Langdock 自己选模型
      modelSelection: { kind: 'auto' },
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
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        if (DEBUG) {
          console.log('\n[bridge] === Langdock 原始响应 ===');
          console.log('  status:', res.statusCode, 'content-type:', ct);
          console.log('  body (前 1000):\n', full.slice(0, 1000));
          console.log('[bridge] === end ===\n');
        }
        resolve({ status: res.statusCode, contentType: ct, body: full });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Langdock 超时')); });
    req.write(body);
    req.end();
  });
}

// ---------- 解析 Langdock 响应 → 纯文本 ----------
// Langdock 用 Vercel AI SDK SSE: 0:"text" d:{"finishReason":"stop"}
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

  // JSON 单体
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
    model: model || 'langdock-auto',
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
  const mk = (delta, fr) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'langdock-auto', choices: [{ index: 0, delta, finish_reason: fr }] })}\n\n`;
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
    model: model || 'langdock-auto',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ---------- Express Router ----------
const router = express.Router();

// 模型列表
router.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'langdock-auto', object: 'model', created: 1700000000, owned_by: 'langdock' },
      { id: 'langdock-claude', object: 'model', created: 1700000000, owned_by: 'langdock' },
      { id: 'langdock-gpt', object: 'model', created: 1700000000, owned_by: 'langdock' },
    ],
  });
});

// OpenAI Chat Completions
router.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream } = req.body || {};
  if (!messages) return res.status(400).json({ error: { message: 'messages required' } });
  const modelMap = (m) => {
    if (!m || m.includes('auto')) return 'auto';
    if (m.includes('claude')) return 'claude';
    if (m.includes('gpt')) return 'gpt';
    return 'auto';
  };
  const ms = modelMap(model);
  log(`/v1/chat/completions model=${model} → ${ms} msgs=${messages.length} stream=${stream}`);
  try {
    const ld = await callLangdock(messages, ms);
    const text = extractText(ld);
    if (ld.status >= 400) return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
    if (stream) return toOpenAIStream(text, model, res);
    res.json(toOpenAIResponse(text, model));
  } catch (e) {
    log('error:', e.message);
    res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
  }
});

// Anthropic Messages
router.post('/v1/messages', async (req, res) => {
  const { messages, model, system } = req.body || {};
  if (!messages) return res.status(400).json({ error: { type: 'invalid_request_error', message: 'messages required' } });
  let msgs = (messages || []).map(m => {
    let c = m.content;
    if (Array.isArray(c)) c = c.filter(x => x.type === 'text').map(x => x.text).join('');
    return { role: m.role, content: c };
  });
  if (system) msgs.unshift({ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) });
  const ms = model && model.includes('gpt') ? 'gpt' : 'claude';
  log(`/v1/messages model=${model} → ${ms} msgs=${msgs.length}`);
  try {
    const ld = await callLangdock(msgs, ms);
    const text = extractText(ld);
    if (ld.status >= 400) return res.status(ld.status).json({ error: { message: 'Langdock: ' + ld.body.slice(0, 500), type: 'upstream_error' } });
    res.json(toClaudeResponse(text, model));
  } catch (e) {
    log('error:', e.message);
    res.status(502).json({ error: { message: e.message, type: 'bridge_error' } });
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
  const ms = model && model.includes('gpt') ? 'gpt' : 'auto';
  log(`/v1/responses model=${model} msgs=${messages.length}`);
  try {
    const ld = await callLangdock(messages, ms);
    const text = extractText(ld);
    res.json({
      id: 'resp_' + uuid().replace(/-/g, ''),
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      model: model || 'langdock-auto',
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
