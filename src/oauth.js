import { randomBytes, createHash } from 'crypto';

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const STATE_TTL_MS = 10 * 60 * 1000;

const stateStore = new Map();

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 生成 PKCE code_verifier 与 code_challenge (S256)
 */
function generatePKCE() {
  const code_verifier = base64UrlEncode(randomBytes(32));
  const challenge = createHash('sha256').update(code_verifier).digest();
  const code_challenge = base64UrlEncode(challenge);
  return { code_verifier, code_challenge };
}

/**
 * 生成随机 state
 */
function generateState() {
  return base64UrlEncode(randomBytes(24));
}

/**
 * 清理过期 state
 */
function pruneState() {
  const now = Date.now();
  for (const [state, data] of stateStore.entries()) {
    if (now - data.createdAt > STATE_TTL_MS) stateStore.delete(state);
  }
}

/**
 * 构建授权 URL 并保存 state 对应的 code_verifier
 * @param {string} redirectUri - 回调地址，例如 http://localhost:8888/auth/callback
 */
export function getAuthorizeUrl(redirectUri) {
  pruneState();
  const { code_verifier, code_challenge } = generatePKCE();
  const state = generateState();
  stateStore.set(state, { code_verifier, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: code_challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
}

/**
 * 用授权码换取 token，并解析出 access_token、account_id
 */
export async function exchangeCodeForToken(code, redirectUri, state) {
  const data = stateStore.get(state);
  if (!data) throw new Error('Invalid or expired state');
  stateStore.delete(state);

  const code_verifier = data.code_verifier;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: code_verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    let errMsg = `Token exchange failed: ${res.status}`;
    try {
      const errJson = JSON.parse(text);
      const errPart = errJson.error != null ? (typeof errJson.error === 'string' ? errJson.error : JSON.stringify(errJson.error)) : '';
      const descPart = errJson.error_description != null ? (typeof errJson.error_description === 'string' ? errJson.error_description : JSON.stringify(errJson.error_description)) : '';
      const msgPart = errJson.message != null ? (typeof errJson.message === 'string' ? errJson.message : JSON.stringify(errJson.message)) : '';
      const parts = [errPart, descPart, msgPart].filter(Boolean);
      if (parts.length) errMsg += ' ' + parts.join(' - ');
    } catch (_) {
      if (text) errMsg += ' ' + text.slice(0, 200);
    }
    throw new Error(errMsg);
  }

  const json = await res.json();
  const access_token = json.access_token;
  if (!access_token) throw new Error('No access_token in response');

  let account_id = json.account_id || json.user?.id || json.user_id;
  let email = json.user?.email || json.email || null;

  if (json.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(json.id_token.split('.')[1], 'base64url').toString()
      );
      if (!account_id) account_id = payload.sub || payload.account_id || payload.user_id;
      if (!email) email = payload.email || null;
      if (!email && (payload.name || payload.preferred_username)) {
        email = payload.name || payload.preferred_username;
      }
    } catch (_) {}
  }
  if (!account_id) account_id = json.sub || 'unknown';

  return { access_token, account_id, refresh_token: json.refresh_token, email };
}

/* ── OpenAI Codex 设备码流程（Device Code Flow）──
 * 端点为 OpenAI 的自定义 deviceauth 接口（非标准 RFC8628 路径），已实测：
 *   1) POST deviceauth/usercode {client_id, scope} -> {device_auth_id, user_code, interval, expires_at}
 *   2) 用户在浏览器打开 auth.openai.com/codex/device 输入 user_code 授权
 *   3) POST deviceauth/token {device_auth_id, user_code} -> 未授权: 403 code=deviceauth_authorization_pending；
 *      授权后: 返回 authorization_code + code_verifier（或直接返回 token）
 *   4) POST oauth/token authorization_code {code, code_verifier, client_id, redirect_uri} -> token
 * redirect_uri 黑盒不可测，默认沿用 codex 的 localhost 回调，可用环境变量覆盖。
 */
const DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const DEVICE_VERIFY_URL = 'https://auth.openai.com/codex/device';
const DEVICE_SCOPE = 'openid profile email offline_access';

function deviceRedirectUri() {
  return process.env.CODEX_DEVICE_REDIRECT_URI || 'http://localhost:1455/auth/callback';
}

function parseCodexTokens(json) {
  const access_token = json.access_token;
  if (!access_token) throw new Error('响应中缺少 access_token');
  let account_id = json.account_id || json.user?.id || json.user_id;
  let email = json.user?.email || json.email || null;
  if (json.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(json.id_token.split('.')[1], 'base64url').toString());
      if (!account_id) account_id = payload.sub || payload.account_id || payload.user_id || payload.chatgpt_account_id;
      if (!email) email = payload.email || payload.name || payload.preferred_username || null;
    } catch (_) {}
  }
  if (!account_id) {
    // access_token 里通常带 chatgpt_account_id / organizations
    try {
      const payload = JSON.parse(Buffer.from(String(access_token).split('.')[1], 'base64url').toString());
      if (!account_id) account_id = payload.chatgpt_account_id || payload['https://api.openai.com/auth']?.chatgpt_account_id || payload.sub;
    } catch (_) {}
  }
  if (!account_id) account_id = 'unknown';
  return { access_token, account_id, refresh_token: json.refresh_token, email };
}

export async function startDeviceAuth() {
  const res = await fetch(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: DEVICE_SCOPE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `设备码申请失败 (HTTP ${res.status})`);
  }
  if (!data.device_auth_id || !data.user_code) {
    throw new Error('设备码响应缺少 device_auth_id/user_code');
  }
  return {
    device_auth_id: data.device_auth_id,
    user_code: data.user_code,
    verification_uri: DEVICE_VERIFY_URL,
    expires_at: data.expires_at || null,
    interval: Math.max(3, Number(data.interval) || 5),
  };
}

async function exchangeDeviceCode(code, code_verifier) {
  // 与 exchangeCodeForToken 保持一致：oauth/token 标准 OAuth 只接受表单编码，
  // 用 application/json 会被判为 Invalid request（token_exchange_user_error）。
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier,
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: deviceRedirectUri(),
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) {}
  if (!res.ok) {
    const raw = json?.error?.message || json?.error_description || json?.message || text?.slice(0, 160) || 'Token 交换失败';
    const ecode = json?.error?.code || (typeof json?.error === 'string' ? json?.error : '') || '';
    const err = new Error(`${raw} (HTTP ${res.status}${ecode ? ' code=' + ecode : ''})`);
    err.code = ecode || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return parseCodexTokens(json);
}

// 单次轮询设备授权。返回 {status:'pending'|'success'|'error', ...}
// 注意：OpenAI 在等待授权期间会返回 403 deviceauth_authorization_pending；
// 此外还可能返回「可重试的瞬时错误」（如 400 "Invalid request. Please try again later."、429、5xx），
// 这类必须当作 pending 继续轮询，绝不能当终态失败——否则一次抖动就会误报"登录失败"。
export async function pollDeviceAuthOnce({ device_auth_id, user_code }) {
  let res;
  try {
    res = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id, user_code }),
    });
  } catch (_) {
    return { status: 'pending' }; // 网络抖动：下个间隔继续轮询
  }
  const data = await res.json().catch(() => ({}));
  const errCode = data?.error?.code;
  const errMsg = data?.error?.message || data?.error_description || '';

  // 仍在等待用户在浏览器完成授权
  if (res.status === 403 || errCode === 'deviceauth_authorization_pending' || /authorization is pending/i.test(errMsg)) {
    return { status: 'pending' };
  }

  if (!res.ok) {
    // 可重试的瞬时错误：限流 / 服务端 / 明确提示"稍后再试"
    const retryable = res.status === 429 || res.status >= 500
      || /try again later|temporar|rate.?limit|slow down|server error|service unavailable/i.test(errMsg);
    if (retryable) return { status: 'pending' };
    // 终态失败（用户拒绝 / 授权过期 / 凭据无效等）
    return { status: 'error', message: `${errMsg || '设备授权轮询失败'} (HTTP ${res.status}${errCode ? ' ' + errCode : ''})`, code: errCode };
  }

  // 授权成功：有的实现直接返回 token，有的返回 authorization_code + code_verifier 再交换
  if (data.access_token) return { status: 'success', ...parseCodexTokens(data) };
  const code = data.authorization_code || data.code;
  const verifier = data.code_verifier;
  if (code && verifier) {
    try {
      return { status: 'success', ...await exchangeDeviceCode(code, verifier) };
    } catch (e) {
      return { status: 'error', message: e.message, code: e.code };
    }
  }
  return { status: 'error', message: '设备授权响应格式未知（无 access_token 也无 authorization_code）' };
}
