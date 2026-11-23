process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

import express from 'express';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { loadAuth, createRoundRobinProvider } from './auth.js';
import {
  handleChatCompletions,
  normalizeClaudeMessagesRequest,
  normalizeOpenAIResponsesRequest,
} from './proxy.js';
import {
  listAccountsForApi,
  addAccount,
  addLocalCodexAccount,
  deleteAccount,
  loadAccountsForProxy,
  getAccountsPath,
  batchAddAccounts,
  updateAccountProxy,
  updateAccount,
  setAccountBlocked,
} from './accounts.js';
import { getAuthorizeUrl, exchangeCodeForToken } from './oauth.js';
import { getLocalCodexLoginStatus, startLocalCodexLogin } from './localCodexLogin.js';
import { isAccountUnavailable } from './accountStatus.js';
import { getRemainingPct, getUsedTokens, QUOTA } from './usageTracker.js';
import { fetchCodexUsage } from './quota.js';
import { generateImage, getCachedImage, fetchImageBytes } from './imagegen.js';
import {
  getAvailableModelsOpenAI,
  getDefaultChatModel,
  getModelsStatus,
  invalidateModels,
  refreshModels,
  initialProbe,
  checkAllAccountsHealth,
} from './models.js';
import {
  startAutoRefresh,
  stopAutoRefresh,
  refreshAllAccounts,
  getAutoRefreshStatus,
} from './tokenAutoRefresh.js';
import { refreshAccessToken } from './tokenRefresh.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const app = express();
// 默认信任反向代理，使 X-Forwarded-Proto / X-Forwarded-Host 生效，绑定时 OAuth 回调地址与用户访问地址一致
app.set('trust proxy', true);
const PORT = Number(process.env.PORT) || 1455;
const AUTH_PATH = process.env.CODEX_AUTH_PATH || null;
const EMAIL_SERVICE_URL = (process.env.EMAIL_SERVICE_URL || 'https://free.violetteam.cloud').replace(/\/$/, '');
const ONECLICK_DOMAINS = ['free.violetteam.cloud', 'qxfy.store', 'deploytools.site', 'loginvipcursor.icu', 'kami666.xyz'];

// ── 管理员认证 ──────────────────────────────────────────
// 通过 ADMIN_PASSWORD 环境变量保护管理后台。
// 生产部署强烈建议配置 ≥ 16 位密码；本地开发未配置时自动跳过认证。
const ADMIN_COOKIE = 'codexproapi_admin';
const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h
function isAdminConfigured() {
  return typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD.length >= 8;
}
function getAdminCookieSignature(timestamp) {
  return createHmac('sha256', process.env.ADMIN_PASSWORD).update(timestamp).digest('base64url');
}
function isAdminAuthenticated(req) {
  if (!isAdminConfigured()) return true; // 未配置密码 → 开发模式放行
  const cookies = String(req.headers.cookie || '').split(';');
  const value = cookies.map((c) => c.trim()).find((c) => c.startsWith(`${ADMIN_COOKIE}=`))
    ?.slice(ADMIN_COOKIE.length + 1);
  if (!value) return false;
  const [timestamp, signature] = value.split('.');
  const issuedAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > ADMIN_SESSION_TTL_SECONDS) return false;
  const expected = getAdminCookieSignature(timestamp);
  const actualBytes = Buffer.from(signature || '');
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
function requireAdmin(req, res, next) {
  if (!isAdminConfigured()) return next(); // 开发模式放行
  if (isAdminAuthenticated(req)) return next();
  // API 请求返回 401，页面请求让前端弹模态框
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(401).json({ error: '需要管理员登录' });
  }
  // 前端页面自己处理（isAdmin 检查）
  next();
}
function setAdminCookie(res, timestamp) {
  const cookie = `${ADMIN_COOKIE}=${timestamp}.${getAdminCookieSignature(timestamp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ADMIN_SESSION_TTL_SECONDS}`;
  res.setHeader('Set-Cookie', cookie + '; Secure');
}
function clearAdminCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getConfigPath() {
  return join(dirname(getAccountsPath()), 'config.json');
}
function loadConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const j = JSON.parse(raw);
    return {
      api_key: typeof j.api_key === 'string' ? j.api_key : '',
      default_model: typeof j.default_model === 'string' ? j.default_model : '',
      token_refresh_interval_minutes:
        Number.isFinite(Number(j.token_refresh_interval_minutes))
          ? Math.max(5, Number(j.token_refresh_interval_minutes))
          : 60,
    };
  } catch {
    return { api_key: '', default_model: '', token_refresh_interval_minutes: 60 };
  }
}
function saveConfig(obj) {
  const p = getConfigPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = {
    api_key: obj.api_key ?? '',
    default_model: typeof obj.default_model === 'string' ? obj.default_model.trim() : '',
    token_refresh_interval_minutes:
      Number.isFinite(Number(obj.token_refresh_interval_minutes))
        ? Math.max(5, Number(obj.token_refresh_interval_minutes))
        : 60,
  };
  writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
}

function randomLocalPart(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function emailInboxHasMail(serviceUrl, email) {
  try {
    const r = await fetch(`${serviceUrl}/api/emails/${encodeURIComponent(email)}`, { method: 'GET' });
    if (!r.ok) return false;
    const data = await r.json().catch(() => ({}));
    const count = data.count != null ? data.count : (data.emails && data.emails.length) || 0;
    return count > 0;
  } catch {
    return false;
  }
}

// 当前使用的认证来源：function（轮询）或 string（单路径）
let authProviderRef = { current: null };

function getAuthProvider() {
  const p = authProviderRef.current;
  if (typeof p === 'function') return p();
  return loadAuth(p);
}

function withDefaultModel(body) {
  const requestedModel = typeof body?.model === 'string' ? body.model.trim() : '';
  const configuredModel = loadConfig().default_model;
  return {
    ...(body && typeof body === 'object' ? body : {}),
    model: requestedModel || configuredModel || getDefaultChatModel(),
  };
}

function refreshAuthProvider() {
  const allAuths = loadAccountsForProxy({ includeBlocked: true });
  const auths = allAuths.filter((auth) => !auth.blocked);
  if (auths.length > 0) {
    authProviderRef.current = createRoundRobinProvider(auths);
    return auths.length;
  }
  if (allAuths.length > 0) {
    authProviderRef.current = () => null;
    return 0;
  }
  authProviderRef.current = AUTH_PATH;
  return 0;
}

// JSON body parser — catch SyntaxError so bad JSON returns clean 400 JSON
app.use((req, res, next) => {
  express.json({ limit: '50mb' })(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: 'Invalid JSON: ' + err.message });
    }
    next();
  });
});
// Fallback: parse form-urlencoded too (some clients send this)
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── 登录状态端点（前端查询） ──
app.get('/api/admin/status', (req, res) => {
  res.json({
    configured: isAdminConfigured(),
    authenticated: isAdminAuthenticated(req),
  });
});
app.post('/api/admin/login', (req, res) => {
  if (!isAdminConfigured()) return res.status(503).json({ error: '未配置 ADMIN_PASSWORD' });
  const submitted = typeof req.body?.password === 'string' ? req.body.password : '';
  const submittedBytes = Buffer.from(submitted);
  const expectedBytes = Buffer.from(process.env.ADMIN_PASSWORD);
  const valid = submittedBytes.length === expectedBytes.length && timingSafeEqual(submittedBytes, expectedBytes);
  if (!valid) return res.status(401).json({ error: '密码错误' });
  const timestamp = String(Math.floor(Date.now() / 1000));
  setAdminCookie(res, timestamp);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

// ── 保护所有管理路由（/api/* 和 /auth/*） ──
// 排除公开端点：健康检查、登录相关、对话 API（/v1/*）
const PUBLIC_API_PATHS = new Set([
  '/api/admin/status', '/api/admin/login', '/api/admin/logout',
  '/health', '/v1/models', '/v1/chat/completions', '/v1/responses',
  '/v1/messages', '/v1/images/generations', '/chat/completions', '/responses',
]);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/auth/')) return next();
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  return requireAdmin(req, res, next);
});

// 版本号以 package.json 为准，供前端统一显示
try {
  const pkgPath = join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json(cfg);
});
app.put('/api/config', (req, res) => {
  const { api_key } = req.body || {};
  saveConfig({ ...loadConfig(), api_key: typeof api_key === 'string' ? api_key : '' });
  res.json({ ok: true });
});
  app.get('/api/version', (req, res) => res.json({ version: pkg.version || '0.0.1' }));
} catch {
  app.get('/api/version', (req, res) => res.json({ version: '0.0.1' }));
}

app.get('/', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});
app.use(express.static(join(__dirname, '..', 'public')));

const requestLogs = [];
const MAX_LOGS = 200;
const LOG_PATHS = ['/health', '/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/chat/completions', '/responses'];

app.use((req, res, next) => {
  if (!LOG_PATHS.includes(req.path)) return next();
  const start = Date.now();
  res._logMeta = { time: new Date().toISOString(), method: req.method, path: req.path };
  res.on('finish', () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'ERR' : status >= 400 ? 'WARN' : 'SUCCESS';
    requestLogs.unshift({
      type: 'request',
      level,
      ...res._logMeta,
      status,
      ms: Date.now() - start,
    });
    if (requestLogs.length > MAX_LOGS) requestLogs.pop();
  });
  next();
});

const API_KEY_PATHS = ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/chat/completions', '/responses'];
app.use((req, res, next) => {
  if (!API_KEY_PATHS.includes(req.path)) return next();
  const cfg = loadConfig();
  if (!cfg.api_key || String(cfg.api_key).trim() === '') return next();
  const authorization = req.headers.authorization;
  const bearerToken = (authorization && String(authorization).startsWith('Bearer '))
    ? String(authorization).slice(7).trim()
    : '';
  const token = bearerToken || (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '');
  if (token !== cfg.api_key) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
});

function getOAuthRedirectUri(req) {
  if (process.env.OAUTH_REDIRECT_URI) return process.env.OAUTH_REDIRECT_URI.trim();
  const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (publicUrl) return `${publicUrl}/auth/callback`;
  const rawProto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  const proto = (typeof rawProto === 'string' ? rawProto.split(',')[0].trim() : rawProto) || 'http';
  const rawHost = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
  let host = (typeof rawHost === 'string' ? rawHost.split(',')[0].trim() : rawHost) || `localhost:${PORT}`;
  if (/^127\.0\.0\.1(:\d+)?$/i.test(host)) host = host.replace(/^127\.0\.0\.1/i, 'localhost');
  return `${proto}://${host}/auth/callback`;
}

const OPENAI_CREATE_ACCOUNT_URL = 'https://auth.openai.com/create-account';

app.get('/auth/login', (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const { url } = getAuthorizeUrl(redirectUri);
  res.redirect(302, url);
});

app.get('/auth/create-account', (req, res) => {
  res.redirect(302, OPENAI_CREATE_ACCOUNT_URL);
});

app.get('/auth/callback', async (req, res) => {
  const redirectUri = getOAuthRedirectUri(req);
  const { code, state, error: oauthError, error_description: oauthDesc } = req.query;
  if (oauthError) {
    const msg = [oauthError, oauthDesc].filter(Boolean).join(': ');
    console.error('OAuth error from provider:', msg);
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent(msg || 'oauth_error')}#/accounts`);
    return;
  }
  if (!code || !state) {
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent('missing_code_or_state')}#/accounts`);
    return;
  }
  try {
    const { access_token, account_id, refresh_token, email } = await exchangeCodeForToken(code, redirectUri, state);
    addAccount({ access_token, account_id, refresh_token, source: 'oauth', name: email || undefined });
    refreshAuthProvider();
    res.redirect(302, '/?oauth=success');
  } catch (e) {
    console.error('OAuth callback error:', e.message, '| redirect_uri:', redirectUri);
    res.redirect(302, `/?oauth=error&msg=${encodeURIComponent(e.message)}#/accounts`);
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'codex-proapi' });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: getAvailableModelsOpenAI(),
  });
});

app.get('/api/models', (req, res) => {
  res.json(getModelsStatus());
});

app.post('/api/models/refresh', async (req, res) => {
  try {
    const status = await refreshModels();
    res.json({ ok: true, ...status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts/health', async (req, res) => {
  try {
    const accounts = await checkAllAccountsHealth();
    res.json({ accounts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  const body = withDefaultModel(req.body);
  if (!body.model) return res.status(503).json({ error: '暂无可用模型，请先添加账号并刷新模型目录' });
  const { accounts } = listAccountsForApi();
  const accountCount = loadAccountsForProxy().length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

app.post('/v1/responses', async (req, res) => {
  let body;
  try {
    body = normalizeOpenAIResponsesRequest(req.body);
  } catch (error) {
    return res.status(400).json({
      error: { message: error.message, type: 'invalid_request_error', code: 'invalid_input' },
    });
  }
  body = withDefaultModel(body);
  if (!body.model) return res.status(503).json({ error: '暂无可用模型，请先添加账号并刷新模型目录' });
  if (body.messages.length === 0) {
    return res.status(400).json({
      error: { message: 'Responses API 的 input 不能为空', type: 'invalid_request_error', code: 'invalid_input' },
    });
  }
  const { accounts } = listAccountsForApi();
  const accountCount = loadAccountsForProxy().length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount, 'response');
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

app.post('/chat/completions', async (req, res) => {
  const body = withDefaultModel(req.body);
  if (!body.model) return res.status(503).json({ error: '暂无可用模型，请先添加账号并刷新模型目录' });
  const { accounts } = listAccountsForApi();
  const accountCount = loadAccountsForProxy().length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

// Claude Messages 格式兼容入口；响应保持 OpenAI Chat Completions 格式
app.post('/v1/messages', async (req, res) => {
  const body = withDefaultModel(normalizeClaudeMessagesRequest(req.body));
  if (!body.model) return res.status(503).json({ error: '暂无可用模型，请先添加账号并刷新模型目录' });
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: 'messages 不能为空' });
  }
  const { accounts } = listAccountsForApi();
  const accountCount = loadAccountsForProxy().length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

// 兼容将 Base URL 设为根且请求 /responses 的客户端（如部分 ChatGPT 风格客户端）
app.post('/responses', async (req, res) => {
  const body = withDefaultModel(req.body);
  if (!body.model) return res.status(503).json({ error: '暂无可用模型，请先添加账号并刷新模型目录' });
  const { accounts } = listAccountsForApi();
  const accountCount = loadAccountsForProxy().length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount);
  if (res._logMeta && usedAuth) {
    const mask = usedAuth.accountId ? usedAuth.accountId.slice(0, 8) + '…' : '—';
    const found = accounts.find((a) => a.accountIdMask === mask);
    res._logMeta.account = found ? (found.name || `账号${found.index + 1}`) : mask;
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ logs: requestLogs });
});
app.delete('/api/logs', (req, res) => {
  requestLogs.length = 0;
  res.json({ ok: true });
});

app.get('/api/usage', async (req, res) => {
  try {
    const auths = loadAccountsForProxy();
    const result = await Promise.all(auths.map(async (auth, i) => {
      if (auth.type !== 'codex' || !auth.accessToken) {
        return { index: auth.index ?? i, remaining_pct: null, used_tokens: null };
      }
      if (isAccountUnavailable(auth.accountId)) {
        return {
          index: auth.index ?? i,
          accountIdMask: `${auth.accountId.slice(0, 8)}…`,
          remaining_pct: 0,
          used_tokens: 0,
          quota: null,
          quota_error: '账号不可用',
        };
      }
      const accountUsage = {
        index: auth.index ?? i,
        accountIdMask: `${auth.accountId.slice(0, 8)}…`,
        remaining_pct: getRemainingPct(auth.accountId),
        used_tokens: getUsedTokens(auth.accountId),
        quota_tokens: QUOTA,
      };
      try {
        return { ...accountUsage, ...(await fetchCodexUsage(auth)) };
      } catch (error) {
        console.warn(`[Usage] ${accountUsage.accountIdMask} 配额读取失败: ${error.message}`);
        return { ...accountUsage, quota: null, quota_error: error.message };
      }
    }));
    res.json({ accounts: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/oneclick/email', async (req, res) => {
  let domainList = ONECLICK_DOMAINS;
  try {
    const r = await fetch(`${EMAIL_SERVICE_URL}/api/domains`, { method: 'GET' });
    if (r.ok) {
      const data = await r.json().catch(() => ({}));
      const fromApi = data.domains && Array.isArray(data.domains) ? data.domains : [];
      if (fromApi.length > 0) {
        domainList = fromApi.map((d) => (d.name || (d.api || '').replace(/^https?:\/\//, '').split('/')[0]).trim()).filter(Boolean);
        if (domainList.length === 0) domainList = ONECLICK_DOMAINS;
      }
    }
  } catch (_) {}
  const maxTries = 15;
  for (let i = 0; i < maxTries; i++) {
    const domain = pickRandom(domainList);
    const local = randomLocalPart(10);
    const email = `${local}@${domain}`;
    const hasMail = await emailInboxHasMail(EMAIL_SERVICE_URL, email);
    if (!hasMail) {
      return res.json({ email });
    }
  }
  const domain = pickRandom(domainList);
  res.json({ email: `${randomLocalPart(10)}@${domain}` });
});

function extractVerificationCodeFromEmail(emailObj) {
  if (emailObj.verificationCode) return emailObj.verificationCode;
  const text = [emailObj.subject, emailObj.text, emailObj.html].filter(Boolean).join(' ');
  const m = text.match(/\b(\d{6})\b/) || text.match(/代码[为為是为]?\s*(\d{6})/i) || text.match(/验证码[：:]\s*(\d{6})/i) || text.match(/code[:\s]+(\d{6})/i);
  return m ? m[1] : null;
}

app.get('/api/oneclick/emails/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  try {
    const r = await fetch(`${EMAIL_SERVICE_URL}/api/emails/${encodeURIComponent(email)}`, { method: 'GET' });
    const data = !r.ok ? { emails: [] } : await r.json().catch(() => ({}));
    const emails = data.emails || [];
    for (let i = 0; i < emails.length; i++) {
      if (!emails[i].verificationCode) {
        const code = extractVerificationCodeFromEmail(emails[i]);
        if (code) emails[i].verificationCode = code;
      }
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/accounts', (req, res) => {
  try {
    res.json(listAccountsForApi());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts', (req, res) => {
  try {
    addAccount(req.body);
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function isLocalRequest(req) {
  const remoteAddress = req.socket.remoteAddress || '';
  const isLoopbackAddress = remoteAddress === '::1'
    || remoteAddress === '127.0.0.1'
    || remoteAddress.startsWith('::ffff:127.');
  if (!isLoopbackAddress) return false;

  try {
    const hostname = new URL(`http://${req.get('host')}`).hostname.replace(/^\[|\]$/g, '');
    return ['localhost', '127.0.0.1', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

app.post('/api/accounts/import-local', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '本机 Codex 导入仅允许通过本机访问' });

  try {
    const result = addLocalCodexAccount(req.body || {});
    refreshAuthProvider();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/accounts/local-login', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '本机 Codex 登录仅允许通过本机访问' });

  const status = startLocalCodexLogin(() => {
    addLocalCodexAccount(req.body || {});
    refreshAuthProvider();
  });
  res.status(status.status === 'error' ? 500 : 202).json(status);
});

app.get('/api/accounts/local-login', (req, res) => {
  if (!isLocalRequest(req)) return res.status(403).json({ error: '本机 Codex 登录状态仅允许通过本机访问' });
  res.json(getLocalCodexLoginStatus());
});

app.delete('/api/accounts/:index', (req, res) => {
  try {
    deleteAccount(req.params.index);
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:index/proxy', (req, res) => {
  try {
    updateAccountProxy(req.params.index, req.body.proxy);
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/accounts/:index/blocked', (req, res) => {
  try {
    const result = setAccountBlocked(req.params.index, req.body?.blocked);
    refreshAuthProvider();
    invalidateModels();
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/accounts/:index', (req, res) => {
  try {
    updateAccount(req.params.index, req.body || {});
    refreshAuthProvider();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/settings', (req, res) => {
  try {
    res.json(loadConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const current = loadConfig();
    const oldInterval = current.token_refresh_interval_minutes;
    if (typeof req.body?.api_key === 'string') current.api_key = req.body.api_key;
    if (typeof req.body?.default_model === 'string') current.default_model = req.body.default_model.trim();
    if (req.body?.token_refresh_interval_minutes != null) {
      const v = Math.max(5, Number(req.body.token_refresh_interval_minutes) || 60);
      current.token_refresh_interval_minutes = v;
    }
    saveConfig(current);
    // 间隔变化 → 重启定时器
    if (current.token_refresh_interval_minutes !== oldInterval) {
      startAutoRefresh(current.token_refresh_interval_minutes, refreshAuthProvider);
    }
    res.json({ ok: true, ...current });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Token 手动刷新 / 状态 ──
app.post('/api/accounts/refresh-tokens', async (req, res) => {
  try {
    const summary = await refreshAllAccounts();
    // 刷新完成后重建认证闭包，新 token 立即生效
    refreshAuthProvider();
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/accounts/refresh-status', (req, res) => {
  res.json(getAutoRefreshStatus());
});

// ── 一键自动注册 ──
function parseAccessToken(accessToken) {
  try {
    const parts = accessToken.split('.');
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      const accountId = payload.sub || (payload['https://api.openai.com/profile'] && payload['https://api.openai.com/profile'].user_id) || 'unknown';
      const email = payload.email || (payload['https://api.openai.com/profile'] && payload['https://api.openai.com/profile'].email) || null;
      return { accountId, email };
    }
  } catch (_) {}
  return { accountId: 'unknown', email: null };
}

app.post('/api/accounts/batch-import', async (req, res) => {
  const { refreshTokens } = req.body || {};
  if (!Array.isArray(refreshTokens) || refreshTokens.length === 0) {
    return res.status(400).json({ error: '无效的 Refresh Token 列表' });
  }
  const results = [];
  const entries = [];
  for (const rt of refreshTokens) {
    const tokenStr = String(rt).trim();
    if (!tokenStr) continue;
    try {
      const tokens = await refreshAccessToken(tokenStr);
      const { accountId, email } = parseAccessToken(tokens.access_token);
      entries.push({
        access_token: tokens.access_token,
        account_id: accountId,
        refresh_token: tokens.refresh_token || tokenStr,
        name: email || undefined,
        source: 'batch_import',
      });
      results.push({ token: tokenStr.slice(0, 15) + '...', status: 'success', accountId, email });
    } catch (e) {
      results.push({ token: tokenStr.slice(0, 15) + '...', status: 'error', error: e.message });
    }
  }
  let importSummary = { imported: 0, updated: 0 };
  if (entries.length > 0) {
    importSummary = batchAddAccounts(entries);
    refreshAuthProvider();
  }
  res.json({
    ok: true,
    total: refreshTokens.length,
    imported: importSummary.imported,
    updated: importSummary.updated,
    results,
  });
});

// ── 图像生成 ──
app.post('/v1/images/generations', async (req, res) => {
  try {
    const auths = loadAccountsForProxy();
    if (auths.length === 0) {
      return res.status(400).json({ error: { message: '未配置账号，请先添加 Codex 账号' } });
    }
    // 选第一个可用账号
    let auth = null;
    for (const a of auths) {
      if (!isAccountUnavailable(a.accountId)) { auth = a; break; }
    }
    if (!auth) {
      return res.status(503).json({ error: { message: '所有账号不可用' } });
    }
    const imageRequest = { ...req.body };
    // Codex 后端自动用 gpt-image-2，不需要指定独立 image 模型
    // 如果客户端没指定 model，就透传给后端让它决定
    if (!imageRequest.model) delete imageRequest.model;
    const result = await generateImage(imageRequest, auth);
    // 将 _token 替换为本地代理 URL
    const host = req.get('host') || `localhost:${PORT}`;
    const proto = (req.get('x-forwarded-proto') || 'http').split(',')[0].trim();
    for (const item of result.data) {
      if (item._token) {
        item.url = `${proto}://${host}/p/img/${item._token}`;
        delete item._token;
      }
    }
    res.json(result);
  } catch (e) {
    console.error('[ImageGen] 错误:', e.message);
    res.status(500).json({ error: { message: e.message } });
  }
});

// ── 图片代理端点 ──
app.get('/p/img/:token', async (req, res) => {
  try {
    const cached = getCachedImage(req.params.token);
    if (!cached) {
      return res.status(404).json({ error: '图片不存在或已过期' });
    }
    const imgBase64 = await fetchImageBytes(
      cached.signedURL, cached.authToken, cached.accountId, cached.deviceId, cached.sessionId, cached.proxyUrl
    );
    const buf = Buffer.from(imgBase64, 'base64');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(buf);
  } catch (e) {
    console.error('[ImageProxy] 错误:', e.message);
    res.status(502).json({ error: e.message });
  }
});

function startServer() {
  const n = refreshAuthProvider();
  if (n > 0) {
    console.log('[OK] 已加载 ' + n + ' 个账号（轮询）');
  } else {
    try {
      loadAuth(AUTH_PATH);
      console.log('[OK] 已加载 Codex 认证（单账号）');
    } catch (e) {
      console.warn('[WARN] 未配置账号，请访问配置页添加或设置 CODEX_AUTH_PATH:', e.message);
    }
  }
  initialProbe();
  // 启动 Token 自动刷新定时器，刷新完成后重建认证闭包使新 token 生效
  const cfg = loadConfig();
  startAutoRefresh(cfg.token_refresh_interval_minutes, refreshAuthProvider);
  const server = app.listen(PORT, '0.0.0.0', () => {
    const mockReq = { get: (h) => (h === 'host' ? `localhost:${PORT}` : undefined), secure: false };
    const oauthRedirect = getOAuthRedirectUri(mockReq);
    console.log('\nCodex Pro API 已启动 http://0.0.0.0:' + PORT);
    console.log('   配置页（添加账号）: http://localhost:' + PORT + '/');
    console.log('   健康检查: http://localhost:' + PORT + '/health');
    console.log('   OAuth 回调（绑定 API 用）: ' + oauthRedirect + (process.env.PUBLIC_URL || process.env.OAUTH_REDIRECT_URI ? ' (已用 PUBLIC_URL/OAUTH_REDIRECT_URI)' : ' (若绑定时 403 请设置 PUBLIC_URL)'));
    console.log('   对话接口: http://localhost:' + PORT + '/v1/chat/completions');
    console.log('   默认模型可在系统设置中选择，也可由请求指定\n');
  });

  setInterval(() => {
    if (loadAccountsForProxy().length > 1) {
      requestLogs.unshift({
        type: 'system',
        level: 'INFO',
        time: new Date().toISOString(),
        method: '',
        pathKey: 'logs.system',
        path: '',
        status: '',
        ms: '',
        messageKey: 'logs.poll_status',
        account: '',
      });
      if (requestLogs.length > MAX_LOGS) requestLogs.pop();
    }
  }, 5000);
  return server;
}

export { app, startServer, PORT };

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === new URL(import.meta.url).href;
if (isMain) {
  startServer();
}
