'use strict';

/**
 * Langdock 反向代理
 * 目标: https://app.langdock.com
 *
 * 功能:
 *   - 反代 app.langdock.com 下所有路由 (含 /chat)
 *   - 自动转发 WebSocket
 *   - 改写 Set-Cookie 的 Domain/Path/Secure, 让登录态在反代域名下可用
 *   - 重写响应体里的绝对 URL, 避免跳回源站
 *   - 支持路径前缀 (PROXY_PREFIX), 例如 http://nas:3000/langdock/chat
 *
 * 运行:
 *   npm install
 *   node proxy.js
 *   访问 http://<nas-ip>:3000/chat
 *
 * 环境变量:
 *   PROXY_PORT    监听端口 (默认 3000)
 *   PROXY_TARGET  源站 (默认 https://app.langdock.com)
 *   PROXY_PREFIX  路径前缀, 如 /langdock (默认空)
 *   COOKIE_DOMAIN 写入 Cookie 的目标 Domain (默认=当前主机)
 *   COOKIE_PATH   写入 Cookie 的目标 Path (默认 /)
 *   REWRITE_BODY  是否重写响应体 (默认 true, 设为 false 关闭)
 *   DEBUG=1       打印调试日志
 */

const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const http = require('http');

// ---------- 配置 ----------
const PORT = process.env.PROXY_PORT || 3000;
const TARGET = process.env.PROXY_TARGET || 'https://app.langdock.com';
const PREFIX = process.env.PROXY_PREFIX || '';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const COOKIE_PATH = process.env.COOKIE_PATH || '/';
const REWRITE_BODY = process.env.REWRITE_BODY !== 'false';
const DEBUG = process.env.DEBUG === '1';

function log(...args) {
  if (DEBUG) console.log('[proxy]', ...args);
}

// ---------- 工具 ----------
function currentHost(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${PREFIX}`;
}

// 改写 Set-Cookie: Domain/Path/Secure/SameSite
function rewriteSetCookie(req, setCookie) {
  if (!setCookie) return setCookie;
  const newHost = COOKIE_DOMAIN || (req.headers.host ? req.headers.host.split(':')[0] : '');
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.map((h) => {
    if (typeof h !== 'string') return h;
    let s = h
      .replace(/;\s*Domain=[^;]*/gi, `; Domain=${newHost}`)
      .replace(/;\s*Path=[^;]*/gi, `; Path=${COOKIE_PATH}`);
    // 反代通常跑在 http 下, 去掉 Secure 否则浏览器不写入
    s = s.replace(/;\s*Secure/gi, '');
    // SameSite=None 在非 Secure 下会被忽略, 改 Lax
    s = s.replace(/;\s*SameSite=None/gi, '; SameSite=Lax');
    return s;
  });
}

// 重写响应体里的绝对 URL
function rewriteBodyStr(req, str) {
  if (!REWRITE_BODY || !str) return str;
  const host = currentHost(req);
  let s = str;
  s = s.split(TARGET).join(host);
  s = s.split('https://app.langdock.com').join(host);
  s = s.split('//app.langdock.com').join(host.replace(/^https?:/, ''));
  return s;
}

function isTextContentType(ct) {
  const c = (ct || '').toLowerCase();
  return (
    c.indexOf('text/html') !== -1 ||
    c.indexOf('application/json') !== -1 ||
    c.indexOf('javascript') !== -1 ||
    c.indexOf('text/css') !== -1 ||
    c.indexOf('xml') !== -1
  );
}

// ---------- app ----------
const app = express();

// 路径前缀剥离
if (PREFIX) {
  app.use((req, _res, next) => {
    if (req.url.indexOf(PREFIX) === 0) {
      req.url = req.url.slice(PREFIX.length) || '/';
      if (req.originalUrl && req.originalUrl.indexOf(PREFIX) === 0) {
        req.originalUrl = req.originalUrl.slice(PREFIX.length) || '/';
      }
    }
    next();
  });
}

// 用 responseInterceptor 处理响应体 (自动解压, 自动复制头, 我们只改 body)
const interceptor = responseInterceptor(async (buffer, proxyRes, req, res) => {
  log('←', proxyRes.statusCode, req.url);
  const ct = proxyRes.headers['content-type'] || '';

  // Set-Cookie 改写 (responseInterceptor 已复制头, 这里覆盖)
  if (proxyRes.headers['set-cookie']) {
    res.setHeader('set-cookie', rewriteSetCookie(req, proxyRes.headers['set-cookie']));
  }
  // Location 重定向改写
  const loc = proxyRes.headers.location;
  if (loc && typeof loc === 'string') {
    let newLoc = loc.replace(TARGET, '').replace('https://app.langdock.com', '');
    if (newLoc.indexOf('/chat') === 0 || newLoc === '/' || newLoc.indexOf('/api') === 0) {
      newLoc = (PREFIX || '') + newLoc;
    }
    res.setHeader('location', newLoc);
  }

  // 响应体重写
  if (isTextContentType(ct)) {
    const str = buffer.toString('utf8');
    return Buffer.from(rewriteBodyStr(req, str), 'utf8');
  }
  return buffer;
});

const proxy = createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  secure: false,
  ws: true,
  selfHandleResponse: true,
  on: {
    proxyReq: (proxyReq, req) => {
      log('→', req.method, req.url);
    },
    // responseInterceptor 作为 proxyRes handler: 自动解压、复制头、改写 body/cookie,
    // 并在结束时 res.end() — 这是 v3 的正确用法 (不能放 plugins 数组)
    proxyRes: interceptor,
    error: (err, req, res) => {
      console.error('[proxy] error', err.message, req && req.url);
      if (res && !res.headersSent) {
        res.writeHead(502);
        res.end('Proxy error: ' + err.message);
      }
    },
  },
});

app.use('/', proxy);

const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  log('⚡ WS upgrade', req.url);
  // http-proxy-middleware v3: ws:true 时自动处理 upgrade, 但需要显式调用
  if (proxy.upgrade) {
    proxy.upgrade(req, socket, head);
  }
});

server.listen(PORT, () => {
  const url = `http://0.0.0.0:${PORT}${PREFIX || ''}`;
  console.log(`\nLangdock 反代已启动`);
  console.log(`  监听:  ${url}`);
  console.log(`  目标:  ${TARGET}`);
  console.log(`  前缀:  ${PREFIX || '(无)'}`);
  console.log(`  调试:  ${DEBUG ? 'ON' : 'off'}  (DEBUG=1 开启)`);
  console.log(`\n  → 访问 ${url}/chat  即可使用 Langdock\n`);
});
