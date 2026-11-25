/**
 * 云端状态持久化（Supabase / 任意 PostgREST 接口）
 *
 * 设计动机：Railway 每次重新部署都是全新容器，容器内的 /data 是临时层，
 * 账号 / 配置 / 用量会在 redeploy 后丢失。这里把若干 JSON 状态文件镜像到一个
 * 云端表（key -> content），实现：
 *   - 启动时：从云端「拉取」全部状态写回本地文件（hydrate）；
 *   - 运行中：每次写文件后「推送」一份到云端（queuePush，去抖 + 失败重试）；
 *   - 退出时：把尚未推送的脏数据刷盘（flushPending）。
 *
 * 关键：不改动原有「同步读文件」的架构。所有读取仍是本地文件；本模块只负责
 * 本地文件 <-> 云端 的双向同步。若未配置 SUPABASE_URL / 秘钥，则整体退化为
 * no-op（纯文件模式，本地 Docker / 桌面版行为完全不变）。
 *
 * 环境变量：
 *   SUPABASE_URL              形如 https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY service_role 秘钥（服务端专用，切勿提交/外泄）
 *   SUPABASE_KEY              备选（同上，二选一即可）
 *   SUPABASE_TABLE           可选，默认 codex_app_state
 *   CODEX_PERSIST_FLUSH_MS   可选，写后去抖间隔，默认 1200ms
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CODEX_DATA_DIR || join(__dirname, '..', 'data');

// 与 accounts.js 完全一致的账号文件解析（不 import 以避免循环依赖）
function accountsPath() {
  return process.env.CODEX_ACCOUNTS_FILE || join(DATA_DIR, 'accounts.json');
}

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
const TABLE = (process.env.SUPABASE_TABLE || 'codex_app_state').trim();
const FLUSH_MS = Math.max(200, Number(process.env.CODEX_PERSIST_FLUSH_MS) || 1200);

export const enabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

// 需要持久化的状态文件名（同时也是云端主键 key）
const PERSISTED = ['accounts.json', 'config.json', 'usage.json', 'image_usage.json', 'image_exhausted.json'];

// key -> 本地绝对路径（hydrate 写回时使用）
function targetPathFor(key) {
  switch (key) {
    case 'accounts.json':
      return accountsPath();
    case 'config.json':
      return join(dirname(accountsPath()), 'config.json');
    default:
      return join(DATA_DIR, key);
  }
}

function ensureDir(p) {
  const dir = dirname(p);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
}

async function rest(method, { body, prefer, qs } = {}) {
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}${qs || ''}`, init);
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

function looksLikeMissingTable(e) {
  if (!e) return false;
  const s = `${e.status || ''} ${e.body || e.message || ''}`;
  return e.status === 404 || /PGRST205|does not exist|relation|schema cache|Could not find/i.test(s);
}

function missingTableHint() {
  console.error(
    `\n[persist] 未在 Supabase 找到表 "${TABLE}"。请在 Supabase 控制台 SQL Editor 执行一次：\n` +
      `  create table if not exists public.${TABLE} (\n` +
      `    key text primary key,\n` +
      `    content text,\n` +
      `    updated_at timestamptz default now()\n` +
      `  );\n` +
      `  alter table public.${TABLE} enable row level security;\n` +
      `（service_role 秘钥可绕过 RLS，无需额外 policy。）\n`
  );
}

/** 启动时调用：从云端拉取全部状态写回本地文件。 */
export async function hydrateFromCloud() {
  if (!enabled) {
    console.log('[persist] 未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，使用纯文件模式');
    return { enabled: false, restored: 0 };
  }
  let rows;
  try {
    rows = await rest('GET', { qs: '?select=key,content' });
  } catch (e) {
    if (looksLikeMissingTable(e)) {
      console.error('[persist] hydrate 失败：云端表不可用');
      missingTableHint();
    } else {
      console.error('[persist] hydrate 失败（继续使用本地文件）：', e.message);
    }
    return { enabled: true, restored: 0, error: e.message };
  }
  const list = Array.isArray(rows) ? rows : [];
  let restored = 0;
  for (const r of list) {
    if (!r || typeof r.key !== 'string' || !PERSISTED.includes(r.key) || r.content == null) continue;
    const p = targetPathFor(r.key);
    try {
      ensureDir(p);
      writeFileSync(p, r.content, 'utf8');
      restored++;
    } catch (e) {
      console.error(`[persist] 写回本地失败 ${r.key}:`, e.message);
    }
  }
  console.log(`[persist] 已从 Supabase 恢复 ${restored} 个状态文件`);
  return { enabled: true, restored };
}

// 脏数据队列：key -> 最近一次写入的绝对路径
const dirty = new Map();
let timer = null;
let dirtyRevision = 0;
let flushPromise = null;

function scheduleFlush() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    flushPending().catch(() => {});
  }, FLUSH_MS);
  if (timer.unref) timer.unref();
}

/** 在本地文件写入后调用：去抖后将该文件推送到云端。fire-and-forget，错误自动重试。 */
export function queuePush(absPath) {
  if (!enabled || !absPath) return;
  const key = basename(absPath);
  if (!PERSISTED.includes(key)) return; // 只同步已知状态文件
  dirty.set(key, { absPath, revision: ++dirtyRevision });
  scheduleFlush();
}

/** 立即把队列中的脏文件 upsert 到云端；成功清空、失败保留待重试。 */
async function flushPendingOnce() {
  if (!enabled || dirty.size === 0) return { pushed: 0 };
  const entries = [...dirty.entries()];
  const rows = [];
  const completed = [];
  for (const [key, entry] of entries) {
    let content;
    try {
      if (!existsSync(entry.absPath)) {
        completed.push([key, entry.revision]); // 文件不存在（例如被删空），移除追踪
        continue;
      }
      content = readFileSync(entry.absPath, 'utf8');
    } catch {
      continue; // 读取异常，保留待下次重试
    }
    rows.push({ key, content, updated_at: new Date().toISOString() });
    completed.push([key, entry.revision]);
  }
  if (rows.length) {
    try {
      await rest('POST', {
        body: rows,
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    } catch (e) {
      if (looksLikeMissingTable(e)) missingTableHint();
      else console.error('[persist] 推送云端失败（将自动重试）:', e.message);
      return { pushed: 0, error: e.message };
    }
  }
  for (const [key, revision] of completed) {
    if (dirty.get(key)?.revision === revision) dirty.delete(key);
  }
  return { pushed: rows.length };
}

export function flushPending() {
  if (!enabled || dirty.size === 0) return Promise.resolve({ pushed: 0 });
  if (flushPromise) return flushPromise;
  flushPromise = flushPendingOnce().finally(() => {
    flushPromise = null;
    if (dirty.size > 0) scheduleFlush();
  });
  return flushPromise;
}

let timersInited = false;
let shuttingDown = false;

/** 注册周期性刷盘与退出钩子（仅在云端模式启用；未配置时不挂任何信号处理器）。 */
export function initPersistTimers() {
  if (!enabled || timersInited) return;
  timersInited = true;
  const iv = setInterval(() => {
    flushPending().catch(() => {});
  }, 15000);
  if (iv.unref) iv.unref();

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[persist] 收到 ${signal}，刷盘后退出...`);
    try {
      await flushPending();
    } catch {
      /* 尽力而为 */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log(`[persist] 云端持久化已启用 -> ${SUPABASE_URL} / 表 ${TABLE}`);
}
