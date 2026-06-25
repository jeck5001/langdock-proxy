#!/usr/bin/env node
'use strict';

/**
 * langdock CLI
 * ------------
 * 管理反代平台的命令行工具, 给 Codex / Claude Code / 脚本调用.
 *
 * 配置 (按优先级):
 *   1. 环境变量 LANGDOCK_URL + LANGDOCK_TOKEN
 *   2. ~/.langdockrc  (JSON: { url, token })
 *   3. langdock config 设置
 *
 * 用法:
 *   langdock config                          交互式设置 url/token
 *   langdock list [--json]                   列出所有代理
 *   langdock get <name> [--json]             查看单个代理
 *   langdock create <name> --target <url> [--port 3001] [--prefix /x] [--json]
 *   langdock start <name>                    启动
 *   langdock stop <name>                     停止
 *   langdock restart <name>                  重启
 *   langdock logs <name> [--tail 200]        查看日志
 *   langdock delete <name>                   删除
 *   langdock status                          系统信息
 *
 * 退出码: 成功 0, 失败 1
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const readline = require('readline');

const RC_FILE = path.join(os.homedir(), '.langdockrc');

// ---------- 配置 ----------
function loadConfig() {
  // env 优先
  if (process.env.LANGDOCK_URL && process.env.LANGDOCK_TOKEN) {
    return { url: process.env.LANGDOCK_URL, token: process.env.LANGDOCK_TOKEN };
  }
  // rc 文件
  try {
    const rc = JSON.parse(fs.readFileSync(RC_FILE, 'utf8'));
    return { url: rc.url, token: rc.token };
  } catch {
    return null;
  }
}

function saveConfig(url, token) {
  fs.writeFileSync(RC_FILE, JSON.stringify({ url, token }, null, 2));
  fs.chmodSync(RC_FILE, 0o600);
  console.log('已保存到 ' + RC_FILE);
}

// ---------- HTTP ----------
function request(cfg, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.url + '/api' + apiPath);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Authorization': 'Bearer ' + cfg.token,
        'Content-Type': 'application/json',
      },
    };
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = null; }
        if (res.statusCode >= 400) {
          const msg = (json && (json.error || json.message)) || data || 'request failed';
          reject(new Error('HTTP ' + res.statusCode + ': ' + msg));
        } else {
          resolve({ status: res.statusCode, json: json, text: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ---------- 输出 ----------
function fail(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function printTable(proxies) {
  if (!proxies || proxies.length === 0) {
    console.log('(no proxies)');
    return;
  }
  // 表头
  const fmt = (s, n) => String(s || '').padEnd(n);
  console.log(fmt('NAME', 20) + fmt('STATUS', 12) + fmt('PORT', 8) + fmt('TARGET', 40) + fmt('PREFIX', 12));
  console.log('-'.repeat(92));
  proxies.forEach(p => {
    const status = p.status?.running ? 'running' : (p.status?.status || 'stopped');
    console.log(
      fmt(p.name, 20) +
      fmt(status, 12) +
      fmt(p.port, 8) +
      fmt(p.target, 40) +
      fmt(p.prefix || '', 12)
    );
  });
}

// ---------- 子命令 ----------
async function cmdConfig() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(r => rl.question(q, r));
  const old = loadConfig() || {};
  const url = (await ask('Manager URL [' + (old.url || 'http://nas-ip:8080') + ']: ')).trim() || old.url || '';
  const token = (await ask('Token [' + (old.token ? '***' : '') + ']: ')).trim() || old.token || '';
  rl.close();
  if (!url || !token) fail('url and token required');
  saveConfig(url, token);
}

async function cmdList(args) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const r = await request(cfg, 'GET', '/proxies');
  if (args.includes('--json')) {
    console.log(JSON.stringify(r.json, null, 2));
  } else {
    printTable(r.json.proxies);
  }
}

async function cmdGet(args) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const name = args[0];
  if (!name) fail('usage: langdock get <name>');
  // list 里找, 因为 id 不直观
  const r = await request(cfg, 'GET', '/proxies');
  const p = r.json.proxies.find(x => x.name === name);
  if (!p) fail('proxy not found: ' + name);
  if (args.includes('--json')) {
    console.log(JSON.stringify(p, null, 2));
  } else {
    console.log('name:    ' + p.name);
    console.log('target:  ' + p.target);
    console.log('port:    ' + p.port);
    console.log('prefix:  ' + (p.prefix || '(none)'));
    console.log('cookie:  ' + (p.cookieDomain || '(request host)'));
    console.log('status:  ' + (p.status?.running ? 'running' : p.status?.status || 'stopped'));
    console.log('id:      ' + p.id);
  }
}

async function cmdCreate(args) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const name = args[0];
  if (!name) fail('usage: langdock create <name> --target <url> [--port 3001]');
  // 解析 --target, --port, --prefix, --cookie-domain
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i+1] : undefined; };
  const body = {
    name,
    target: get('--target'),
    port: get('--port') ? parseInt(get('--port'), 10) : 3000,
    prefix: get('--prefix') || '',
    cookieDomain: get('--cookie-domain') || '',
  };
  if (!body.target) fail('--target required');
  const r = await request(cfg, 'POST', '/proxies', body);
  if (args.includes('--json')) {
    console.log(JSON.stringify(r.json, null, 2));
  } else {
    const p = r.json.proxy || r.json;
    console.log('created: ' + p.name + ' → ' + p.target + ' : ' + p.port);
    if (r.json.error) console.log('warning: ' + r.json.error);
  }
}

async function cmdAction(args, action) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const name = args[0];
  if (!name) fail('usage: langdock ' + action + ' <name>');
  const id = await nameToId(cfg, name);
  const r = await request(cfg, 'POST', '/proxies/' + id + '/' + action);
  console.log(action + ' ' + name + ': ok');
}

async function cmdLogs(args) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const name = args[0];
  if (!name) fail('usage: langdock logs <name> [--tail 200]');
  const tailI = args.indexOf('--tail');
  const tail = tailI >= 0 ? args[tailI+1] : '200';
  const id = await nameToId(cfg, name);
  const r = await request(cfg, 'GET', '/proxies/' + id + '/logs?tail=' + tail);
  process.stdout.write(r.json.logs || '');
}

async function cmdDelete(args) {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const name = args[0];
  if (!name) fail('usage: langdock delete <name>');
  const id = await nameToId(cfg, name);
  await request(cfg, 'DELETE', '/proxies/' + id);
  console.log('deleted: ' + name);
}

async function cmdStatus() {
  const cfg = loadConfig();
  if (!cfg) fail('未配置. 运行: langdock config');
  const r = await request(cfg, 'GET', '/system');
  console.log(JSON.stringify(r.json, null, 2));
}

// name → id 转换
async function nameToId(cfg, name) {
  const r = await request(cfg, 'GET', '/proxies');
  const p = r.json.proxies.find(x => x.name === name);
  if (!p) fail('proxy not found: ' + name);
  return p.id;
}

// ---------- main ----------
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'config': await cmdConfig(); break;
      case 'list': case 'ls': await cmdList(args); break;
      case 'get': await cmdGet(args); break;
      case 'create': await cmdCreate(args); break;
      case 'start': await cmdAction(args, 'start'); break;
      case 'stop': await cmdAction(args, 'stop'); break;
      case 'restart': await cmdAction(args, 'restart'); break;
      case 'logs': await cmdLogs(args); break;
      case 'delete': case 'rm': await cmdDelete(args); break;
      case 'status': await cmdStatus(); break;
      case undefined: case '-h': case '--help': case 'help':
        console.log(`langdock - manage reverse proxies

commands:
  config                              设置 URL 和 token
  list [--json]                       列出所有代理
  get <name> [--json]                 查看单个代理
  create <name> --target <url>        创建代理
    [--port 3001] [--prefix /x] [--cookie-domain d.com]
  start <name>                        启动
  stop <name>                         停止
 restart <name>                       重启
  logs <name> [--tail 200]            查看日志
  delete <name>                       删除
  status                              系统信息

config: 环境变量 LANGDOCK_URL + LANGDOCK_TOKEN, 或 ~/.langdockrc, 或 langdock config`);
        break;
      default:
        fail('unknown command: ' + cmd + ' (try: langdock help)');
    }
  } catch (e) {
    fail(e.message);
  }
}

main();
