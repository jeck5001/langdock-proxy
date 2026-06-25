'use strict';

/**
 * Langdock Bridge — 把 Langdock 账号转成 OpenAI / Claude 兼容 API
 *
 * 原理:
 *   Langdock 的 /api/engine 接收 {messages:[{role,parts:[{type:text,text}]}], ...}
 *   用 Cookie 认证 (auth_token + cf_clearance + ...)
 *   本服务把 OpenAI/Claude 格式的请求转成 Langdock 格式, 调用后把响应转回.
 *
 * 暴露的端点 (兼容各客户端):
 *   POST /v1/chat/completions   OpenAI Chat 格式 (Cursor / Continue / OpenAI SDK)
 *   POST /v1/messages           Anthropic Claude 格式 (Claude Code)
 *   POST /v1/responses          OpenAI Responses 格式 (Codex) — 复用 chat/completions 逻辑
 *   GET  /v1/models             返回模型列表
 *
 * 配置 (环境变量):
 *   BRIDGE_PORT        监听端口 (默认 8963, 和 QCCG 一致)
 *   LANGDOCK_COOKIE    Langdock 的 Cookie 字符串 (必填, 从浏览器抓)
 *   LANGDOCK_BASE      Langdock 基地址 (默认 https://app.langdock.com)
 *   LANGDOCK_WORKSPACE workspace id (从 cookie/state 提取, 或手动填)
 *   BRIDGE_TOKEN       可选: 保护本 API 的 token (不填则不校验)
 *   DEBUG=1            打印 Langdock 原始响应, 便于调试响应转换
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

// ---------- 配置 ----------
const PORT = process.env.BRIDGE_PORT || 8963;
const LANGDOCK_BASE = process.env.LANGDOCK_BASE || 'https://app.langdock.com';
const LANGDOCK_COOKIE = process.env.LANGDOCK_COOKIE || '';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const DEBUG = process.env.DEBUG === '1';

if (!LANGDOCK_COOKIE) {
  console.error('\n========================================');
  console.error('  未设置 LANGDOCK_COOKIE!');
  console.error('  请从浏览器抓取 app.langdock.com 的 Cookie,');
  console.error('  设置环境变量 LANGDOCK_COOKIE 后重启.');
  console.error('========================================\n');
}

// ---------- 工具: 生成 UUID ----------
function uuid() {
  return crypto.randomUUID();
}

// ---------- 工具: 发请求到 Langdock ----------
function callLangdock(messages, modelSelection) {
  return new Promise((resolve, reject) => {
    const url = new URL(LANGDOCK_BASE + '/api/engine');
    const threadId = uuid();
    const parentId = uuid();

    // 把 OpenAI messages 转成 Langdock 格式
    // OpenAI: [{role:'user'|'assistant'|'system', content:'text'}]
    // Langdock: [{id, role, parts:[{type:'text', text}], metadata:{...}}]
    const ldMessages = messages.map((m, i) => {
      const isLast = i === messages.length - 1;
      return {
        id: uuid(),
        role: m.role === 'system' ? 'user' : m.role, // Langdock 只认 user/assistant
        parts: [{ type: 'text', text: m.content || '' }],
        metadata: isLast ? {
          createdAt: new Date().toISOString(),
          threadId,
          parentId,
          selectedTool: null,
          selectedInternalSearchIntegrations: [],
          attachments: [],
          taggedIntegrations: [],
          taggedKnowledgeFolders: [],
          taggedWorkflows: [],
          taggedAssistantId: null,
          modelId: modelSelection || 'auto',
          modelProvider: null,
          modelName: null,
          userFeedback: null,
          autoModelTier: 'auto',
        } : {
          createdAt: new Date().toISOString(),
          threadId,
          parentId,
        },
      };
    });

    const convId = uuid();
    const body = JSON.stringify({
      id: convId,
      conversationSource: 'WEB',
      userTimezone: 'Asia/Shanghai',
      modelSelection: { kind: modelSelection || 'auto' },
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
      // Langdock 可能返回 SSE 流或 JSON
      const ct = res.headers['content-type'] || '';
      let raw = '';
      let chunks = [];
      let bufLen = 0;

      res.on('data', (chunk) => {
        chunks.push(chunk);
        bufLen += chunk.length;
        if (DEBUG && bufLen < 4000) {
          // 打印前 4KB 原始响应, 便于调试格式
          raw += chunk.toString('utf8');
        }
      });
      res.on('end', () => {
        const full = Buffer.concat(chunks).toString('utf8');
        if (DEBUG) {
          console.log('\n[bridge] === Langdock 原始响应 ===');
          console.log('  status:', res.statusCode);
          console.log('  content-type:', ct);
          console.log('  body (前 2000 字符):\n', full.slice(0, 2000));
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
// Langdock 用 Vercel AI SDK 的 SSE 格式:
//   0:"text chunk"          ← text delta (type 0)
//   d:{"finishReason":"stop"} ← done
// 也兼容传统 SSE (data: {...}) 和 JSON 单体
function extractText(langdockResp) {
  const { body, contentType } = langdockResp;
  const texts = [];
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) continue;

    // 1) Vercel AI SDK 格式: 0:"text" / 2:{...} / d:{...}
    //    数字后跟冒号, 值是 JSON
    const vercelMatch = trimmed.match(/^(\d+|d):\s*(.*)$/);
    if (vercelMatch) {
      const type = vercelMatch[1];
      const payload = vercelMatch[2];
      try {
        const val = JSON.parse(payload);
        // type 0 = text delta (val 是 string)
        if (type === '0' && typeof val === 'string') {
          texts.push(val);
        }
        // type 2 = tool call 等, 忽略
        // type d = done, 忽略
      } catch {}
      continue;
    }

    // 2) 传统 SSE: data: {...}
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
      continue;
    }
  }

  if (texts.length) return texts.join('');

  // 3) JSON 单体 (非 SSE)
  try {
    const obj = JSON.parse(body);
    const t = obj.text || obj.content || obj.message
      || (obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content)
      || '';
    if (t) return t;
  } catch {}

  // 兜底: 原样返回 (调试时能看到原始内容)
  return body;
}

// ---------- OpenAI Chat Completions 响应构造 ----------
function toOpenAIResponse(text, model) {
  return {
    id: 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model || 'langdock-auto',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// OpenAI 流式 (SSE) 响应构造
function toOpenAIStream(text, model, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const id = 'chatcmpl-' + uuid().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  // 起始
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'langdock-auto', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  // 内容 (整块发, 后续可改成分块)
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'langdock-auto', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  // 结束
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: model || 'langdock-auto', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// ---------- Anthropic Messages 响应构造 ----------
function toClaudeResponse(text, model) {
  return {
    id: 'msg_' + uuid().replace(/-/g, ''),
    type: 'message',
    role: 'assistant',
    model: model || 'langdock-auto',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// ---------- Express-like 路由 (用原生 http, 不加依赖) ----------
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // 收 body
  const getBody = () => new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => resolve(d));
  });

  // 认证 (可选)
  if (BRIDGE_TOKEN) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('key');
    if (token !== BRIDGE_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid token', type: 'auth_error' } }));
      return;
    }
  }

  // ---------- 路由 ----------

  // GET /  — 简单首页
  if (path === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><body><h1>Langdock Bridge</h1><p>OpenAI/Claude 兼容 API → Langdock</p><ul><li>POST /v1/chat/completions (OpenAI)</li><li>POST /v1/messages (Claude)</li><li>GET /v1/models</li></ul><p>Cookie: ${LANGDOCK_COOKIE ? '已配置' : '<b>未配置</b>'}</p></body></html>`);
    return;
  }

  // GET /v1/models
  if (path === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'langdock-auto', object: 'model', created: 1700000000, owned_by: 'langdock' },
        { id: 'langdock-claude', object: 'model', created: 1700000000, owned_by: 'langdock' },
        { id: 'langdock-gpt', object: 'model', created: 1700000000, owned_by: 'langdock' },
      ],
    }));
    return;
  }

  // POST /v1/chat/completions  (OpenAI)
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = JSON.parse(await getBody() || '{}');
    const messages = body.messages || [];
    const stream = body.stream === true;
    // 把 OpenAI model 名映射到 Langdock modelSelection
    const modelMap = (m) => {
      if (!m || m === 'langdock-auto' || m.includes('auto')) return 'auto';
      if (m.includes('claude')) return 'claude';
      if (m.includes('gpt')) return 'gpt';
      return 'auto';
    };
    const ms = modelMap(body.model);
    console.log(`[bridge] /v1/chat/completions model=${body.model} → ${ms} msgs=${messages.length} stream=${stream}`);
    try {
      const ld = await callLangdock(messages, ms);
      const text = extractText(ld);
      if (ld.status >= 400) {
        res.writeHead(ld.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Langdock error: ' + ld.body.slice(0, 500), type: 'upstream_error' } }));
        return;
      }
      if (stream) {
        toOpenAIStream(text, body.model, res);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(toOpenAIResponse(text, body.model)));
      }
    } catch (e) {
      console.error('[bridge] error', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_error' } }));
    }
    return;
  }

  // POST /v1/messages  (Anthropic Claude)
  if (path === '/v1/messages' && req.method === 'POST') {
    const body = JSON.parse(await getBody() || '{}');
    // Claude messages: [{role, content}]  content 可能是 string 或 [{type:text,text}]
    const messages = (body.messages || []).map(m => {
      let content = m.content;
      if (Array.isArray(content)) {
        content = content.filter(c => c.type === 'text').map(c => c.text).join('');
      }
      return { role: m.role, content };
    });
    // system 单独处理: Claude 的 system 字段塞到开头
    if (body.system) {
      messages.unshift({ role: 'system', content: typeof body.system === 'string' ? body.system : JSON.stringify(body.system) });
    }
    const ms = body.model && body.model.includes('gpt') ? 'gpt' : 'claude';
    console.log(`[bridge] /v1/messages model=${body.model} → ${ms} msgs=${messages.length} stream=${body.stream}`);
    try {
      const ld = await callLangdock(messages, ms);
      const text = extractText(ld);
      if (ld.status >= 400) {
        res.writeHead(ld.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Langdock error: ' + ld.body.slice(0, 500), type: 'upstream_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(toClaudeResponse(text, body.model)));
    } catch (e) {
      console.error('[bridge] error', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message, type: 'bridge_error' } }));
    }
    return;
  }

  // POST /v1/responses  (OpenAI Responses — Codex 用)
  // 复用 chat/completions 逻辑, 把 input 转成 messages
  if (path === '/v1/responses' && req.method === 'POST') {
    const body = JSON.parse(await getBody() || '{}');
    let messages = [];
    if (body.input) {
      // input 可能是 string 或 [{role, content}]
      if (typeof body.input === 'string') {
        messages = [{ role: 'user', content: body.input }];
      } else if (Array.isArray(body.input)) {
        messages = body.input.map(m => {
          let c = m.content;
          if (Array.isArray(c)) c = c.map(x => x.text || '').join('');
          return { role: m.role || 'user', content: c };
        });
      }
    }
    const ms = (body.model && body.model.includes('gpt')) ? 'gpt' : 'auto';
    console.log(`[bridge] /v1/responses model=${body.model} msgs=${messages.length}`);
    try {
      const ld = await callLangdock(messages, ms);
      const text = extractText(ld);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // OpenAI Responses 格式
      res.end(JSON.stringify({
        id: 'resp_' + uuid().replace(/-/g, ''),
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: body.model || 'langdock-auto',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
        status: 'completed',
      }));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found: ' + path } }));
});

server.listen(PORT, () => {
  console.log(`\nLangdock Bridge 已启动`);
  console.log(`  监听:  http://0.0.0.0:${PORT}`);
  console.log(`  Cookie: ${LANGDOCK_COOKIE ? '已配置 (' + LANGDOCK_COOKIE.length + ' 字符)' : '未配置!'}`);
  console.log(`  Base:   ${LANGDOCK_BASE}`);
  console.log(`  Token:  ${BRIDGE_TOKEN ? '已设置' : '无 (不校验)'}`);
  console.log(`  Debug:  ${DEBUG ? 'ON' : 'off'}`);
  console.log(`\n  端点:`);
  console.log(`    POST /v1/chat/completions  (OpenAI)`);
  console.log(`    POST /v1/messages          (Claude)`);
  console.log(`    POST /v1/responses         (Codex)`);
  console.log(`    GET  /v1/models\n`);
});
