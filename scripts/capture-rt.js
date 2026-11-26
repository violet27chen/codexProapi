#!/usr/bin/env node
/**
 * 截获 ChatGPT 登录后返回的 Codex refresh_token（本机运行）
 *
 * 原理：走标准 OAuth 授权码 + PKCE，回调到 http://localhost:<port>/auth/callback。
 *   - 这个 client 只允许 localhost 回调，所以必须在「本机」跑（不是 Railway）。
 *   - 换 token 从本机住宅 IP 发起，不会被服务器侧的 Cloudflare 拦。
 * 用法：每个账号跑一次，浏览器里用对应账号登录，终端即打印该账号的 refresh_token，
 *   并累加写入 ./captured-rt.txt（每行一个），全部跑完后把该文件到 Railway「批量导入」。
 *
 *   node scripts/capture-rt.js
 *   可选：RT_PORT=1456 node scripts/capture-rt.js   （默认 1455，需与回调端口一致）
 */
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { getAuthorizeUrl, exchangeCodeForToken } from '../src/oauth.js';

const PORT = Number(process.env.RT_PORT || 1455);
const REDIRECT = `http://localhost:${PORT}/auth/callback`;
const OUT_FILE = process.env.RT_OUT || 'captured-rt.txt';
const TIMEOUT_MS = 5 * 60 * 1000;

const { url, state } = getAuthorizeUrl(REDIRECT);

function openBrowser(u) {
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', u], { stdio: 'ignore', detached: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [u], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [u], { stdio: 'ignore', detached: true }).unref();
  } catch (_) { /* 打不开就手动复制 URL */ }
}

function done(code) {
  try { server.close(); } catch (_) {}
  clearTimeout(guard);
  setTimeout(() => process.exit(code), 300);
}

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, `http://localhost:${PORT}`); } catch { res.writeHead(400).end(); return; }
  if (u.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }

  const err = u.searchParams.get('error');
  const code = u.searchParams.get('code');
  const st = u.searchParams.get('state');
  const html = (s) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(s); };

  if (err) {
    html(`<h3>❌ 授权失败：${err}</h3><p>${u.searchParams.get('error_description') || ''}</p>`);
    console.error('授权失败:', err, u.searchParams.get('error_description') || '');
    return done(1);
  }
  if (!code) { res.writeHead(400).end('missing code'); return; }
  if (st !== state) { res.writeHead(400).end('state mismatch（可能超时或重复回调）'); return; }

  try {
    const tok = await exchangeCodeForToken(code, REDIRECT, state);
    html('<h3>✅ 登录成功，可关闭本页。</h3><p>refresh_token 已在终端打印，并已追加到 ' + OUT_FILE + '。</p>');
    console.log('\n===== 截获到的 Codex 凭据 =====');
    console.log('email        :', tok.email || '(未知)');
    console.log('account_id   :', tok.account_id);
    console.log('refresh_token:');
    console.log(tok.refresh_token);
    try { appendFileSync(OUT_FILE, (tok.refresh_token || '') + '\n', 'utf8'); } catch (e) { console.error('写入文件失败:', e.message); }
    console.log('\n→ 已追加到 ' + OUT_FILE + '。要再加一个账号：再运行一次本脚本，浏览器里换账号登录即可。');
    console.log('→ 全部加完后，把 ' + OUT_FILE + ' 到 Railway 版「导入账号文件 / 批量导入」。');
    done(0);
  } catch (e) {
    html(`<h3>❌ 换 token 失败</h3><pre>${(e.message || '').replace(/</g, '&lt;')}</pre>`);
    console.error('换 token 失败:', e.message);
    done(1);
  }
});

const guard = setTimeout(() => {
  console.error('\n超时（5 分钟）未收到回调，退出。请重新运行。');
  done(1);
}, TIMEOUT_MS);

server.listen(PORT, '127.0.0.1', () => {
  console.log('监听 ' + REDIRECT);
  console.log('请用【目标账号】在浏览器完成登录授权：\n');
  console.log(url + '\n');
  openBrowser(url);
});
