import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseAuthFromJson, resolveAuthPath } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACCOUNTS_FILE = join(__dirname, '..', 'data', 'accounts.json');

function getAccountsPath() {
  return process.env.CODEX_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
}

/**
 * 读取账号列表（不包含 token 明文，用于 API 展示）
 */
export function formatProxyDisplay(proxyStr) {
  if (!proxyStr || typeof proxyStr !== 'string' || !proxyStr.trim()) return null;
  const str = proxyStr.trim();
  try {
    const hasProto = /^[a-zA-Z0-9+-.]+:\/\//.test(str);
    const parseStr = hasProto ? str : `http://${str}`;
    const u = new URL(parseStr);
    const proto = hasProto ? u.protocol : '';
    const host = u.host;
    const label = u.hash ? decodeURIComponent(u.hash.slice(1)) : '';
    
    let display = proto ? `${proto}//${host}` : host;
    if (label) {
      display = `${label} (${display})`;
    }
    return display;
  } catch (_) {
    return str;
  }
}

/**
 * 读取账号列表（不包含 token 明文，用于 API 展示）
 */
export function listAccountsForApi() {
  const path = getAccountsPath();
  if (!existsSync(path)) return { accounts: [] };
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  return {
    accounts: list.map((item, index) => {
      const accountId = item.account_id || item.tokens?.account_id || '';
      const accessToken = item.access_token || item.tokens?.access_token || '';
      let tokenExp = null;
      try {
        const parts = accessToken.split('.');
        if (parts.length >= 2) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          if (payload.exp) tokenExp = payload.exp * 1000;
        }
      } catch (_) {}
      return {
        index,
        name: item.name || `账号 ${index + 1}`,
        accountId: accountId || '',
        accountIdMask: accountId ? `${accountId.slice(0, 8)}…` : '—',
        source: item.source || 'manual',
        tokenExp,
        hasRefreshToken: !!(item.refresh_token || item.tokens?.refresh_token),
        blocked: item.blocked === true,
        proxy: item.proxy || null, // 原始代理 URL
        proxyDisplay: formatProxyDisplay(item.proxy), // 格式化展示用代理
      };
    }),
  };
}

/**
 * 导出账号的 Refresh Token 列表（每个一行），用于备份/迁移；与批量导入格式一致。
 * 注意：包含敏感凭据，调用方必须做管理员鉴权。
 */
export function exportAccounts() {
  const path = getAccountsPath();
  if (!existsSync(path)) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const tokens = [];
  for (const item of list) {
    const rt = item.refresh_token || item.tokens?.refresh_token;
    const str = rt ? String(rt).trim() : '';
    if (str) tokens.push(str);
  }
  return tokens;
}

/**
 * 读取完整账号列表（含 token），供代理轮询使用
 */
export function loadAccountsForProxy({ includeBlocked = false } = {}) {
  const path = getAccountsPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const auths = [];
  for (const [index, item] of list.entries()) {
    if (!includeBlocked && item.blocked === true) continue;
    const tokens = item.tokens || (item.access_token ? { access_token: item.access_token, account_id: item.account_id } : null);
    if (tokens?.access_token && tokens?.account_id) {
      auths.push({
        type: 'codex',
        accessToken: tokens.access_token,
        accountId: tokens.account_id,
        name: item.name || null,
        proxyUrl: item.proxy || null, // 代理 URL
        index,
        blocked: item.blocked === true,
      });
    }
  }
  return auths;
}

export function setAccountBlocked(index, blocked) {
  if (typeof blocked !== 'boolean') throw new Error('屏蔽状态必须为布尔值');
  const path = getAccountsPath();
  if (!existsSync(path)) throw new Error('账号文件不存在');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const accountIndex = Number(index);
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= list.length) {
    throw new Error('未找到指定账号');
  }
  list[accountIndex].blocked = blocked;
  writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  return { ok: true, blocked };
}

/**
 * 添加一个账号并写入文件
 * body: { name?, access_token, account_id, proxy? } 或 { name?, authJson: "...", proxy? }
 */
export function addAccount(body) {
  const path = getAccountsPath();
  let entry;
  if (body.authJson) {
    const data = JSON.parse(body.authJson);
    const auth = parseAuthFromJson(data);
    if (auth.type !== 'codex') throw new Error('仅支持 Codex 账号（access_token + account_id）');
    const tokens = data.tokens || data;
    entry = {
      name: body.name || null,
      access_token: auth.accessToken,
      account_id: auth.accountId,
      refresh_token: body.refresh_token || tokens.refresh_token || undefined,
      source: body.source || 'manual',
      proxy: body.proxy || null,
    };
  } else if (body.access_token && body.account_id) {
    entry = {
      name: body.name || null,
      access_token: body.access_token,
      account_id: body.account_id,
      refresh_token: body.refresh_token || undefined,
      source: body.source || 'manual',
      proxy: body.proxy || null,
    };
  } else {
    throw new Error('请提供 authJson（粘贴 auth.json 内容）或 access_token + account_id');
  }
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let list = [];
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    list = Array.isArray(data) ? data : (data.accounts || []);
  }
  const existingIndex = list.findIndex(item => {
    const itemAccountId = item.account_id || item.tokens?.account_id;
    return itemAccountId && itemAccountId === entry.account_id;
  });
  if (existingIndex >= 0) {
    const existing = list[existingIndex];
    const existingTokens = existing.tokens ? {
      ...existing.tokens,
      access_token: entry.access_token,
      account_id: entry.account_id,
      refresh_token: entry.refresh_token || existing.tokens.refresh_token,
    } : undefined;
    list[existingIndex] = {
      ...existing,
      ...entry,
      name: body.name !== undefined ? entry.name : (existing.name || entry.name),
      refresh_token: entry.refresh_token || existing.refresh_token || existing.tokens?.refresh_token,
      proxy: body.proxy !== undefined ? entry.proxy : (existing.proxy || null),
      ...(existingTokens ? { tokens: existingTokens } : {}),
    };
    writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
    return { ok: true, updated: true, duplicate: true, index: existingIndex };
  }
  list.push(entry);
  writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  return { ok: true, updated: false, duplicate: false, index: list.length - 1 };
}

/**
 * Import the Codex CLI session from this machine's auth.json.
 */
export function addLocalCodexAccount(options = {}) {
  const authPath = resolveAuthPath(process.env.CODEX_AUTH_PATH);
  let data;
  try {
    data = JSON.parse(readFileSync(authPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`未找到本机 Codex 登录信息（${authPath}），请先运行 codex login`);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`本机 Codex auth.json 格式错误：${error.message}`);
    }
    throw new Error(`无法读取本机 Codex 登录信息：${error.message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('本机 Codex auth.json 内容无效');
  }
  const auth = parseAuthFromJson(data);
  if (auth.type !== 'codex' || !auth.accessToken || !auth.accountId) {
    throw new Error('本机 Codex auth.json 中未找到 access_token 和 account_id，请先运行 codex login');
  }

  const tokens = data.tokens || data;
  return addAccount({
    name: options.name || data.email || tokens.email || undefined,
    access_token: auth.accessToken,
    account_id: auth.accountId,
    refresh_token: tokens.refresh_token,
    source: 'local_codex',
    proxy: options.proxy || null,
  });
}

/**
 * 按索引删除账号
 */
export function deleteAccount(index) {
  const path = getAccountsPath();
  if (!existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const i = Number(index);
  if (i >= 0 && i < list.length) {
    list.splice(i, 1);
    writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  }
}

export function batchAddAccounts(entries) {
  const path = getAccountsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let list = [];
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw);
    list = Array.isArray(data) ? data : (data.accounts || []);
  }
  let imported = 0;
  let updated = 0;
  for (const entry of entries) {
    const normalized = {
      name: entry.name || null,
      access_token: entry.access_token,
      account_id: entry.account_id,
      refresh_token: entry.refresh_token,
      source: entry.source || 'batch_import',
      proxy: entry.proxy || null,
    };
    const existingIndex = list.findIndex(item => {
      const itemAccountId = item.account_id || item.tokens?.account_id;
      return itemAccountId && itemAccountId === normalized.account_id;
    });
    if (existingIndex >= 0) {
      const existingTokens = list[existingIndex].tokens ? {
        ...list[existingIndex].tokens,
        access_token: normalized.access_token,
        account_id: normalized.account_id,
        refresh_token: normalized.refresh_token || list[existingIndex].tokens.refresh_token,
      } : undefined;
      list[existingIndex] = {
        ...list[existingIndex],
        ...normalized,
        name: normalized.name || list[existingIndex].name,
        refresh_token: normalized.refresh_token || list[existingIndex].refresh_token,
        ...(existingTokens ? { tokens: existingTokens } : {}),
      };
      updated++;
    } else {
      list.push(normalized);
      imported++;
    }
  }
  writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  return { ok: true, imported, updated };
}

/**
 * 绑定或更新账号代理
 */
export function updateAccountProxy(index, proxyUrl) {
  const path = getAccountsPath();
  if (!existsSync(path)) throw new Error('账号文件不存在');
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const i = Number(index);
  if (i >= 0 && i < list.length) {
    list[i].proxy = proxyUrl ? String(proxyUrl).trim() : null;
    writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
    return { ok: true };
  }
  throw new Error('未找到指定账号');
}

/**
 * 更新账号完整信息；未提供的敏感字段保持原值。
 */
export function updateAccount(index, changes = {}) {
  const path = getAccountsPath();
  if (!existsSync(path)) throw new Error('账号文件不存在');
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);
  const list = Array.isArray(data) ? data : (data.accounts || []);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) {
    throw new Error('未找到指定账号');
  }

  const current = list[i];
  const nextAccountId = String(changes.account_id ?? current.account_id ?? current.tokens?.account_id ?? '').trim();
  if (!nextAccountId) throw new Error('Account ID 不能为空');
  const duplicateIndex = list.findIndex((item, itemIndex) => {
    if (itemIndex === i) return false;
    const accountId = item.account_id || item.tokens?.account_id;
    return accountId === nextAccountId;
  });
  if (duplicateIndex >= 0) {
    throw new Error('该 Account ID 已存在于账号列表中');
  }

  const nextAccessToken = String(changes.access_token ?? current.access_token ?? current.tokens?.access_token ?? '').trim();
  if (!nextAccessToken) throw new Error('Access Token 不能为空');

  const nextRefreshToken = String(
    changes.refresh_token !== undefined
      ? changes.refresh_token
      : (current.refresh_token || current.tokens?.refresh_token || '')
  ).trim();
  const next = {
    ...current,
    name: changes.name !== undefined ? String(changes.name).trim() || null : current.name,
    access_token: nextAccessToken,
    account_id: nextAccountId,
    proxy: changes.proxy !== undefined ? (String(changes.proxy).trim() || null) : current.proxy,
  };
  if (nextRefreshToken) next.refresh_token = nextRefreshToken;
  else delete next.refresh_token;
  if (current.tokens) {
    next.tokens = {
      ...current.tokens,
      access_token: nextAccessToken,
      account_id: nextAccountId,
      ...(nextRefreshToken ? { refresh_token: nextRefreshToken } : {}),
    };
  }

  list[i] = next;
  writeFileSync(path, JSON.stringify({ accounts: list }, null, 2), 'utf8');
  return { ok: true };
}

export { getAccountsPath };
