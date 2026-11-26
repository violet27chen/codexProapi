/**
 * 多提供商聚合：提供商目录的存储 / CRUD / 路由解析。
 *
 * 设计：本 app 仍是 Codex 反代（不带前缀的模型走原 Codex 后端）。新增“提供商”后，
 * 客户端用 `提供商名/模型id` 选择目标，网关按最长提供商名前缀路由到对应提供商。
 * 提供商的 base_url + api_key 直接透传/翻译，聚合到一个入口，免去频繁切换。
 *
 * 存储：providers.json（与 accounts.json 同目录，纳入 Supabase 持久化）。
 * 结构：[{ id, name, type, base_url, api_key, models:[], enabled, created_at }]
 *   type: 'openai' | 'anthropic' | 'google'
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { queuePush } from './persist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CODEX_DATA_DIR || join(__dirname, '..', 'data');

const TYPES = new Set(['openai', 'anthropic', 'google']);

// 内置提供商预设（端点为各家公开的 OpenAI/Anthropic/Gemini 兼容地址，可编辑覆盖）
const PRESETS = [
  { key: 'openai', label: 'OpenAI', type: 'openai', base_url: 'https://api.openai.com/v1' },
  { key: 'deepseek', label: 'DeepSeek', type: 'openai', base_url: 'https://api.deepseek.com/v1' },
  { key: 'moonshot', label: 'Moonshot Kimi', type: 'openai', base_url: 'https://api.moonshot.cn/v1' },
  { key: 'zhipu', label: '智谱 GLM', type: 'openai', base_url: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'dashscope', label: '阿里云百炼 DashScope', type: 'openai', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', type: 'openai', base_url: 'https://api.siliconflow.cn/v1' },
  { key: 'openrouter', label: 'OpenRouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1' },
  { key: 'groq', label: 'Groq', type: 'openai', base_url: 'https://api.groq.com/openai/v1' },
  { key: 'mistral', label: 'Mistral', type: 'openai', base_url: 'https://api.mistral.ai/v1' },
  { key: 'xai', label: 'xAI Grok', type: 'openai', base_url: 'https://api.x.ai/v1' },
  { key: 'together', label: 'Together AI', type: 'openai', base_url: 'https://api.together.xyz/v1' },
  { key: 'anthropic', label: 'Anthropic Claude', type: 'anthropic', base_url: 'https://api.anthropic.com' },
  { key: 'gemini', label: 'Google Gemini', type: 'google', base_url: 'https://generativelanguage.googleapis.com' },
];

export function listProviderPresets() { return PRESETS; }

function accountsPath() {
  return process.env.CODEX_ACCOUNTS_FILE || join(DATA_DIR, 'accounts.json');
}
function providersPath() {
  return join(dirname(accountsPath()), 'providers.json');
}

function loadRaw() {
  const p = providersPath();
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : (data.providers || []);
  } catch {
    return [];
  }
}

function save(list) {
  const p = providersPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({ providers: list }, null, 2), 'utf8');
  queuePush(p);
}

// 规范化：name 作为路由前缀，必须安全且唯一
function normalizeName(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return n;
}

function sanitize(input = {}, existing = []) {
  const name = normalizeName(input.name);
  if (!name) throw new Error('提供商名称不能为空（仅限字母/数字/-/_，用作模型前缀）');
  if (name === 'codex') throw new Error('“codex” 是内置保留前缀，请换一个名字');
  const type = TYPES.has(input.type) ? input.type : 'openai';
  const base_url = String(input.base_url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base_url)) throw new Error('base_url 需以 http(s):// 开头');
  const api_key = String(input.api_key || '').trim();
  const models = Array.isArray(input.models)
    ? input.models.map((m) => String(m).trim()).filter(Boolean)
    : [];
  const enabled = input.enabled !== false;
  return { name, type, base_url, api_key, models, enabled };
}

/** 列表（脱敏：api_key 只留末 4 位） */
export function listProvidersForApi() {
  return loadRaw().map((p, index) => ({
    index,
    id: p.id,
    name: p.name,
    type: p.type || 'openai',
    base_url: p.base_url || '',
    keyMask: p.api_key ? `••••${String(p.api_key).slice(-4)}` : '',
    hasKey: !!p.api_key,
    models: Array.isArray(p.models) ? p.models : [],
    enabled: p.enabled !== false,
    created_at: p.created_at || null,
  }));
}

/** 原始列表（含 key，仅服务端内部使用） */
export function listProviders() {
  return loadRaw();
}

export function addProvider(input) {
  const list = loadRaw();
  const clean = sanitize(input, list);
  if (list.some((p) => p.name === clean.name)) throw new Error(`已存在同名提供商：${clean.name}`);
  const entry = { id: randomUUID(), created_at: new Date().toISOString(), ...clean };
  list.push(entry);
  save(list);
  return { ok: true, id: entry.id, name: entry.name };
}

export function updateProvider(index, changes = {}) {
  const list = loadRaw();
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('未找到指定提供商');
  const cur = list[i];
  // 若改了 name/type/base_url 走完整校验；api_key 留空表示保持原值
  const merged = {
    name: changes.name !== undefined ? changes.name : cur.name,
    type: changes.type !== undefined ? changes.type : cur.type,
    base_url: changes.base_url !== undefined ? changes.base_url : cur.base_url,
    api_key: changes.api_key !== undefined && String(changes.api_key).trim() !== '' ? changes.api_key : cur.api_key,
    models: changes.models !== undefined ? changes.models : cur.models,
    enabled: changes.enabled !== undefined ? changes.enabled : cur.enabled,
  };
  const clean = sanitize(merged, list);
  if (list.some((p, idx) => idx !== i && p.name === clean.name)) throw new Error(`已存在同名提供商：${clean.name}`);
  list[i] = { ...cur, ...clean };
  save(list);
  return { ok: true };
}

export function deleteProvider(index) {
  const list = loadRaw();
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('未找到指定提供商');
  list.splice(i, 1);
  save(list);
  return { ok: true };
}

export function setProviderEnabled(index, enabled) {
  const list = loadRaw();
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) throw new Error('未找到指定提供商');
  list[i].enabled = !!enabled;
  save(list);
  return { ok: true, enabled: !!enabled };
}

/**
 * 路由解析：model 若以 `<提供商名>/` 开头（取最长匹配，兼容 org/model 型 id），
 * 返回 { provider, model }（model 已去掉前缀，并按别名映射成上游真实 id）；否则 null（走内置 Codex）。
 * 模型条目支持 `显示名=真实id`：客户端只写 `提供商名/显示名`（两段），网关转发时替换为真实 id。
 */
function parseModelEntry(entry) {
  const s = String(entry || '').trim();
  const eq = s.indexOf('=');
  if (eq > 0) return { display: s.slice(0, eq).trim(), upstream: s.slice(eq + 1).trim() };
  return { display: s, upstream: s };
}

export function resolveRouting(model) {
  if (typeof model !== 'string' || !model.includes('/')) return null;
  const enabled = loadRaw().filter((p) => p.enabled !== false);
  let best = null;
  for (const p of enabled) {
    if (model.startsWith(`${p.name}/`) && (!best || p.name.length > best.name.length)) best = p;
  }
  if (!best) return null;
  const after = model.slice(best.name.length + 1);
  let upstream = after;
  for (const entry of (Array.isArray(best.models) ? best.models : [])) {
    const { display, upstream: real } = parseModelEntry(entry);
    if (display && display === after) { upstream = real; break; }
  }
  return { provider: best, model: upstream };
}

/** 供 /v1/models 聚合：把每个启用提供商的模型按“显示名”列出（不含真实 id） */
export function listProviderModelIds() {
  const out = [];
  for (const p of loadRaw()) {
    if (p.enabled === false) continue;
    for (const entry of (Array.isArray(p.models) ? p.models : [])) {
      const { display } = parseModelEntry(entry);
      if (display) out.push({ id: `${p.name}/${display}`, owned_by: p.type });
    }
  }
  return out;
}

export { providersPath };
