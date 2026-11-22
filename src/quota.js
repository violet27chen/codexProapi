import { getProxyAgent } from './proxyAgent.js';
import { refreshTokenByAccountId } from './tokenRefresh.js';

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function normalizePlan(planType) {
  if (typeof planType !== 'string' || !planType.trim()) {
    return { planLabel: null, isMember: null };
  }
  const plan = planType.trim().toLowerCase().replace(/^chatgpt_/, '');
  if (plan === 'free') return { planLabel: 'Free', isMember: false };
  const knownPlans = {
    plus: 'Plus',
    pro: 'Pro',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
  };
  const planLabel = knownPlans[plan] || planType.trim();
  return { planLabel, isMember: true };
}

function normalizeWindow(window) {
  if (
    !window
    || typeof window !== 'object'
    || window.used_percent == null
    || !Number.isFinite(Number(window.used_percent))
  ) {
    return null;
  }
  const usedPercent = Math.min(100, Math.max(0, Number(window.used_percent)));
  return {
    remaining_pct: Math.round(100 - usedPercent),
    reset_at: window.reset_at ?? null,
  };
}

function getQuotaWindows(payload) {
  const rateLimit = payload?.rate_limit || {};
  const windows = Object.entries(rateLimit)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([name, value]) => ({
      name: name.toLowerCase(),
      duration: Number(value.limit_window_seconds),
      quota: normalizeWindow(value),
    }))
    .filter((window) => window.quota);

  const findByDuration = (minimum, maximum) =>
    windows.find(({ duration }) => duration >= minimum && duration <= maximum)?.quota || null;
  const findByName = (name) =>
    windows.find((window) => window.name.includes(name))?.quota || null;
  const monthly =
    normalizeWindow(rateLimit.monthly_window)
    || normalizeWindow(rateLimit.monthly)
    || normalizeWindow(payload?.monthly_window)
    || normalizeWindow(payload?.monthly_rate_limit);

  return {
    five_hour: findByDuration(4 * 60 * 60, 6 * 60 * 60),
    weekly: findByDuration(5 * 24 * 60 * 60, 9 * 24 * 60 * 60),
    monthly:
      monthly
      || findByDuration(28 * 24 * 60 * 60, 35 * 24 * 60 * 60)
      || findByName('month'),
    primary: normalizeWindow(rateLimit.primary_window),
    secondary: normalizeWindow(rateLimit.secondary_window),
  };
}

function getModelQuotas(payload) {
  const candidates = [];
  const directMaps = [
    payload?.model_rate_limits,
    payload?.model_limits,
    payload?.rate_limit?.model_rate_limits,
    payload?.rate_limit?.model_limits,
  ];

  for (const map of directMaps) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [model, limit] of Object.entries(map)) {
      if (!limit || typeof limit !== 'object') continue;
      candidates.push({ model, limit });
    }
  }

  const directArrays = [
    payload?.additional_rate_limits,
    payload?.model_rate_limits,
    payload?.model_limits,
  ];
  for (const list of directArrays) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const model = entry.model
        || entry.model_slug
        || entry.slug
        || entry.limit_name
        || entry.name
        || entry.label;
      if (typeof model === 'string' && model.trim()) {
        candidates.push({ model: model.trim(), limit: entry.rate_limit || entry });
      }
    }
  }

  const seen = new Set();
  return candidates.reduce((result, { model, limit }) => {
    const key = model.trim();
    if (!key || seen.has(key)) return result;
    seen.add(key);
    const quotaSource = limit?.rate_limit ? limit : { rate_limit: limit };
    const quota = getQuotaWindows(quotaSource);
    const remaining = normalizeWindow(limit)
      || quota.primary
      || quota.five_hour
      || quota.secondary
      || quota.weekly
      || quota.monthly;
    if (!remaining) return result;
    result.push({
      model: key,
      remaining_pct: remaining.remaining_pct,
      reset_at: remaining.reset_at,
      quota,
    });
    return result;
  }, []);
}

export function normalizeCodexUsage(payload) {
  const { planLabel, isMember } = normalizePlan(payload?.plan_type);
  const windows = getQuotaWindows(payload);

  return {
    plan_type: payload?.plan_type || null,
    plan_label: planLabel,
    is_member: isMember,
    model_quotas: getModelQuotas(payload),
    quota: {
      five_hour: isMember ? windows.five_hour || windows.primary : null,
      weekly: isMember ? windows.weekly || windows.secondary : null,
      monthly: windows.monthly,
    },
  };
}

export async function fetchCodexUsage(auth) {
  const request = (accessToken) => fetch(USAGE_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'chatgpt-account-id': auth.accountId,
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/',
    },
    dispatcher: getProxyAgent(auth.proxyUrl),
    signal: AbortSignal.timeout(12000),
  });

  let response = await request(auth.accessToken);
  if ((response.status === 401 || response.status === 403) && auth.accountId) {
    const refreshed = await refreshTokenByAccountId(auth.accountId);
    if (refreshed?.accessToken && refreshed.accessToken !== auth.accessToken) {
      response = await request(refreshed.accessToken);
    }
  }
  if (!response.ok) {
    throw new Error(`读取账号配额失败 HTTP ${response.status}`);
  }
  return normalizeCodexUsage(await response.json());
}
