/**
 * 模型可用性探测器
 *
 * 候选模型列表会被逐个发送最小请求到 Codex 后端验证，只返回真实可用的。
 * 探测结果缓存 1 小时；可通过 /api/models/refresh 强制刷新。
 */
import { randomUUID } from 'crypto';
import { loadAccountsForProxy } from './accounts.js';
import { isAccountUnavailable, markAccountUnavailable } from './accountStatus.js';
import { refreshTokenByAccountId } from './tokenRefresh.js';
import { getProxyAgent } from './proxyAgent.js';

const BACKEND_URL = 'https://chatgpt.com/backend-api/codex/responses';

// 候选模型清单（仅保留探测确认存在的模型）
const CANDIDATES = [
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
];

// 图片生成模型（使用 conversation API，不通过 codex/responses 探测，有账号则可用）
const IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-1',
];

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const PROBE_TIMEOUT_MS = 12 * 1000;

// 与 proxy.js 完全一致的请求头，任何字段缺失都会被 ChatGPT 拒绝
const BROWSER_HEADERS = {
  'Accept': 'text/event-stream',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Referer': 'https://chatgpt.com/',
  'Origin': 'https://chatgpt.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'DNT': '1',
  'OpenAI-Beta': 'responses=experimental',
  'originator': 'codex_cli_rs',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

let cache = {
  lastProbed: 0,
  inProgress: false,
  results: {}, // { modelId: { available, latency, reason?, probedAt } }
};
let probePromise = null; // 单飞：并发调用复用同一 promise

/**
 * 选一个当前可用的账号用于探测
 */
function pickProbeAccount() {
  const auths = loadAccountsForProxy();
  for (const a of auths) {
    if (a.type === 'codex' && a.accessToken && a.accountId && !isAccountUnavailable(a.accountId)) {
      return a;
    }
  }
  return null;
}

function buildHeaders(auth) {
  return {
    ...BROWSER_HEADERS,
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${auth.accessToken}`,
    'chatgpt-account-id': auth.accountId,
    'session_id': randomUUID(),
  };
}

async function sendProbe(modelId, auth, signal) {
  const body = {
    model: modelId,
    instructions: 'probe',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false,
    reasoning: null,
    store: false,
    stream: true,
    include: [],
  };
  const dispatcher = getProxyAgent(auth.proxyUrl);
  return fetch(BACKEND_URL, {
    method: 'POST',
    headers: buildHeaders(auth),
    body: JSON.stringify(body),
    signal,
    dispatcher,
  });
}

/**
 * 探测单个模型 — 发送最小请求体，401/403 时刷新 token 重试一次
 */
async function probeModel(modelId, auth) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

  try {
    let res = await sendProbe(modelId, auth, ctrl.signal);

    // 401/403 → 刷新 token 重试一次（同 proxy.js 逻辑）
    if ((res.status === 401 || res.status === 403) && auth.accountId) {
      try {
        const refreshed = await refreshTokenByAccountId(auth.accountId);
        if (refreshed && refreshed.accessToken && refreshed.accessToken !== auth.accessToken) {
          auth.accessToken = refreshed.accessToken;
          res = await sendProbe(modelId, auth, ctrl.signal);
        }
      } catch (_) {}
    }

    const latency = Date.now() - start;

    if (res.status === 200) {
      try { res.body?.cancel?.(); } catch {}
      return { available: true, latency };
    }

    const text = await res.text().catch(() => '');

    if (res.status === 401 || res.status === 403) {
      // 区分细分原因：token_invalidated（被服务端作废）vs 普通过期
      if (/token_invalidated/.test(text)) {
        return { available: false, latency, reason: 'token_invalidated' };
      }
      return { available: false, latency, reason: 'auth_failed' };
    }

    if (
      res.status === 404 ||
      /model.*not.*(found|support|exist)|invalid.*model|unknown.*model|does not exist/i.test(text)
    ) {
      return { available: false, latency, reason: 'model_not_found', status: res.status };
    }
    return { available: false, latency, reason: `http_${res.status}` };
  } catch (e) {
    return {
      available: false,
      latency: Date.now() - start,
      reason: e.name === 'AbortError' ? 'timeout' : 'network_error',
      error: e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测全部候选模型 — 自动跨账号：第一个账号 token 失效时切下一个
 */
function probeAll() {
  if (probePromise) return probePromise;
  probePromise = (async () => {
    const auths = loadAccountsForProxy().filter(
      (a) => a.type === 'codex' && a.accessToken && a.accountId
    );
    if (auths.length === 0) {
      cache.lastProbed = Date.now();
      cache.results = {};
      return;
    }
    cache.inProgress = true;
    const newResults = {};
    try {
      // 用首个候选模型逐个测试账号，找到一个健康账号
      let activeAuth = null;
      for (const candidate of auths) {
        if (isAccountUnavailable(candidate.accountId)) continue;
        const probeAuth = { ...candidate };
        const test = await probeModel(CANDIDATES[0], probeAuth);
        if (test.available) {
          activeAuth = probeAuth;
          newResults[CANDIDATES[0]] = { ...test, probedAt: Date.now() };
          break;
        }
        if (test.reason === 'token_invalidated' || test.reason === 'auth_failed') {
          // 标记失效，后续不再选中
          markAccountUnavailable(candidate.accountId);
          continue;
        }
        if (test.reason === 'model_not_found') {
          // 账号可用，但首个候选模型不存在 — 仍可用此账号继续
          activeAuth = probeAuth;
          newResults[CANDIDATES[0]] = { ...test, probedAt: Date.now() };
          break;
        }
        // 其它情况（网络错误等），换下一个账号试
      }

      if (!activeAuth) {
        // 全部账号失效
        for (const m of CANDIDATES) {
          if (!newResults[m]) {
            newResults[m] = {
              available: false,
              latency: 0,
              reason: 'no_healthy_account',
              probedAt: Date.now(),
            };
          }
        }
        cache.results = newResults;
        cache.lastProbed = Date.now();
        return;
      }

      // 用找到的健康账号探测剩余模型
      for (const modelId of CANDIDATES) {
        if (newResults[modelId]) continue;
        const r = await probeModel(modelId, { ...activeAuth });
        newResults[modelId] = { ...r, probedAt: Date.now() };
        await new Promise((res) => setTimeout(res, 200));
      }
      cache.results = newResults;
      cache.lastProbed = Date.now();
    } finally {
      cache.inProgress = false;
    }
  })().finally(() => { probePromise = null; });
  return probePromise;
}

/**
 * 强制重新探测（清除缓存并 await 完成）
 */
export async function refreshModels() {
  cache.lastProbed = 0;
  await probeAll();
  return getModelsStatus();
}

/**
 * 后台懒探测：缓存过期且没有进行中，启动一次（fire-and-forget）
 */
function maybeProbeInBackground() {
  if (probePromise) return;
  if (Date.now() - cache.lastProbed < CACHE_TTL_MS) return;
  probeAll().catch((e) => console.error('[models] 探测异常:', e.message));
}

/**
 * 获取 OpenAI 兼容格式的可用模型列表（用于 /v1/models）
 * 如缓存为空，返回默认值并后台启动探测
 */
export function getAvailableModelsOpenAI() {
  maybeProbeInBackground();
  const ids = Object.entries(cache.results)
    .filter(([, r]) => r.available)
    .map(([id]) => id);

  // 如果还没探测过，返回保守默认值（用户不会卡在空列表）
  const textIds = ids.length > 0 ? ids : ['gpt-5.3-codex'];
  const hasAccount = loadAccountsForProxy().some(
    (a) => a.type === 'codex' && a.accessToken && !isAccountUnavailable(a.accountId)
  );
  const allIds = hasAccount ? [...textIds, ...IMAGE_MODELS] : textIds;
  return allIds.map((id) => ({
    id,
    object: 'model',
    created: 1687882411,
    owned_by: 'openai',
  }));
}

/**
 * 获取完整的探测状态（用于前端 /api/models 详细页）
 */
export function getModelsStatus() {
  maybeProbeInBackground();
  const textModels = CANDIDATES.map((id) => ({
    id,
    ...(cache.results[id] || { available: null, latency: null, reason: 'not_probed' }),
  }));
  const hasAccount = loadAccountsForProxy().some(
    (a) => a.type === 'codex' && a.accessToken && !isAccountUnavailable(a.accountId)
  );
  const imageModels = IMAGE_MODELS.map((id) => ({
    id,
    available: hasAccount ? true : false,
    latency: null,
    reason: hasAccount ? null : 'no_account',
  }));
  return {
    lastProbed: cache.lastProbed,
    inProgress: cache.inProgress,
    models: [...textModels, ...imageModels],
  };
}

/**
 * 检查所有账号的 token 健康状态（每账号一次最小探测）
 * 返回：[{ accountId, healthy, reason, latency }]
 */
export async function checkAllAccountsHealth() {
  const auths = loadAccountsForProxy();
  const out = [];
  for (const auth of auths) {
    if (auth.type !== 'codex' || !auth.accessToken || !auth.accountId) {
      out.push({ accountId: auth.accountId, healthy: false, reason: 'no_token', latency: 0 });
      continue;
    }
    const r = await probeModel('gpt-5.3-codex', { ...auth });
    out.push({
      accountId: auth.accountId,
      healthy: r.available,
      reason: r.reason || null,
      latency: r.latency,
    });
    await new Promise((res) => setTimeout(res, 150));
  }
  return out;
}

/**
 * 服务启动时触发初次探测（如有账号）
 */
export function initialProbe() {
  // 延迟 3 秒启动，等待账号加载完成
  setTimeout(() => {
    if (loadAccountsForProxy().length > 0) {
      probeAll().catch((e) => console.error('[models] 初始探测失败:', e.message));
    }
  }, 3000);
}
