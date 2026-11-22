process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

import express from 'express';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { loadAuth, createRoundRobinProvider } from './auth.js';
import { handleChatCompletions } from './proxy.js';
import {
  listAccountsForApi,
  addAccount,
  deleteAccount,
  loadAccountsForProxy,
  getAccountsPath,
  batchAddAccounts,
  updateAccountProxy,
} from './accounts.js';
import { getAuthorizeUrl, exchangeCodeForToken } from './oauth.js';
import { isAccountUnavailable } from './accountStatus.js';
import { getRemainingPct, getUsedTokens, QUOTA } from './usageTracker.js';
import { generateImage, getCachedImage, fetchImageBytes } from './imagegen.js';
import {
  getAvailableModelsOpenAI,
  getDefaultChatModel,
  getModelsStatus,
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
  const auths = loadAccountsForProxy();
  if (auths.length > 0) {
    authProviderRef.current = createRoundRobinProvider(auths);
    return auths.length;
  }
  authProviderRef.current = AUTH_PATH;
  return 0;
}

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
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
  app.get('/api/version', (req, res) => res.json({ version: pkg.version || '0.0.0' }));
} catch {
  app.get('/api/version', (req, res) => res.json({ version: '0.0.0' }));
}

app.get('/', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  res.sendFile(join(__dirname, '..', 'public', 'index.html'));
});
app.use(express.static(join(__dirname, '..', 'public')));

const requestLogs = [];
const MAX_LOGS = 200;
const LOG_PATHS = ['/health', '/v1/models', '/v1/chat/completions', '/chat/completions', '/responses'];

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

const API_KEY_PATHS = ['/v1/models', '/v1/chat/completions', '/chat/completions', '/responses'];
app.use((req, res, next) => {
  if (!API_KEY_PATHS.includes(req.path)) return next();
  const cfg = loadConfig();
  if (!cfg.api_key || String(cfg.api_key).trim() === '') return next();
  const auth = req.headers.authorization;
  const token = (auth && String(auth).startsWith('Bearer ')) ? String(auth).slice(7).trim() : '';
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
  const accountCount = accounts.length || 1;
  const usedAuth = await handleChatCompletions(body, res, getAuthProvider, accountCount);
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
  const accountCount = accounts.length || 1;
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
  const accountCount = accounts.length || 1;
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
    const result = [];
    for (let i = 0; i < auths.length; i++) {
      const auth = auths[i];
      if (auth.type !== 'codex' || !auth.accessToken) {
        result.push({ index: i, remaining_pct: null, used_tokens: null });
        continue;
      }
      if (isAccountUnavailable(auth.accountId)) {
        result.push({ index: i, remaining_pct: 0, used_tokens: 0 });
        continue;
      }
      result.push({
        index: i,
        remaining_pct: getRemainingPct(auth.accountId),
        used_tokens: getUsedTokens(auth.accountId),
        quota_tokens: QUOTA,
      });
    }
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
  if (entries.length > 0) {
    batchAddAccounts(entries);
    refreshAuthProvider();
  }
  res.json({
    ok: true,
    total: refreshTokens.length,
    imported: entries.length,
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
    const result = await generateImage(req.body, auth);
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
