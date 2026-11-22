/**
 * Token 自动刷新调度器
 *
 * 定期遍历 accounts.json 中所有有 refresh_token 的账号，
 * 调用 refresh_token endpoint 换取新 access_token 并写回。
 * 刷新成功后会清除该账号在 unavailableIds 中的"不可用"标记。
 *
 * 可配置：刷新间隔（分钟），保存在 data/config.json 的 token_refresh_interval_minutes。
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { refreshTokenForAccount } from './tokenRefresh.js';
import { unmarkAccountUnavailable } from './accountStatus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CODEX_DATA_DIR || join(__dirname, '..', 'data');
const DEFAULT_ACCOUNTS_FILE = join(DATA_DIR, 'accounts.json');

function getAccountsPath() {
  return process.env.CODEX_ACCOUNTS_FILE || DEFAULT_ACCOUNTS_FILE;
}

let timerId = null;
let isRefreshing = false;
let onCompleteCallback = null;
let state = {
  lastRun: 0,
  lastSummary: null,
  intervalMinutes: 60,
  active: false,
};

/**
 * 对所有有 refresh_token 的账号执行一次刷新
 */
export async function refreshAllAccounts() {
  if (isRefreshing) {
    return { skipped: true, message: '已有刷新进行中' };
  }
  isRefreshing = true;
  const summary = {
    startedAt: Date.now(),
    ok: 0,
    fail: 0,
    skipped: 0,
    total: 0,
    details: [],
  };
  try {
    const path = getAccountsPath();
    if (!existsSync(path)) {
      state.lastRun = Date.now();
      state.lastSummary = summary;
      return summary;
    }
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(data) ? data : (data.accounts || []);
    summary.total = list.length;

    for (let i = 0; i < list.length; i++) {
      const acc = list[i];
      const refreshToken = acc.refresh_token || acc.tokens?.refresh_token || null;
      const accountId = acc.account_id || acc.tokens?.account_id || `idx-${i}`;
      const mask = accountId.length > 12 ? accountId.slice(0, 12) + '…' : accountId;

      if (acc.blocked === true) {
        summary.skipped++;
        summary.details.push({ accountId, mask, status: 'blocked' });
        continue;
      }

      if (!refreshToken) {
        summary.skipped++;
        summary.details.push({ accountId, mask, status: 'no_refresh_token' });
        continue;
      }
      try {
        const newToken = await refreshTokenForAccount(i);
        if (newToken) {
          // 刷新成功 → 清除"不可用"标记，让该账号获得重试机会
          unmarkAccountUnavailable(accountId);
          summary.ok++;
          summary.details.push({ accountId, mask, status: 'refreshed' });
        } else {
          summary.fail++;
          summary.details.push({ accountId, mask, status: 'refresh_failed' });
        }
      } catch (e) {
        summary.fail++;
        summary.details.push({ accountId, mask, status: 'error', error: e.message });
      }
      // 串行间隔，避免触发 OAuth 频率限制
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    isRefreshing = false;
    summary.finishedAt = Date.now();
    summary.elapsedMs = summary.finishedAt - summary.startedAt;
    state.lastRun = Date.now();
    state.lastSummary = summary;
  }
  console.log(`[autoRefresh] 完成: ${summary.ok}/${summary.total} 成功, ${summary.fail} 失败, ${summary.skipped} 跳过`);
  // 通知调用方重建认证闭包（使内存 token 与磁盘同步）
  if (typeof onCompleteCallback === 'function') {
    try { onCompleteCallback(); } catch (_) {}
  }
  return summary;
}

/**
 * 启动定时刷新，若已有定时器则重启
 * @param {number} intervalMinutes 间隔（分钟），最小 5
 * @param {Function} [onComplete] 每次刷新完成后的回调（用于通知调用方重建认证闭包）
 */
export function startAutoRefresh(intervalMinutes = 60, onComplete = null) {
  stopAutoRefresh();
  if (onComplete) onCompleteCallback = onComplete;
  const minutes = Math.max(5, Number(intervalMinutes) || 60);
  state.intervalMinutes = minutes;
  state.active = true;
  const ms = minutes * 60 * 1000;
  timerId = setInterval(() => {
    refreshAllAccounts().catch((e) => console.error('[autoRefresh] 异常:', e.message));
  }, ms);
  console.log(`[autoRefresh] 已启动，间隔 ${minutes} 分钟`);
}

/** 更新刷新完成回调（不重启定时器） */
export function setRefreshCompleteCallback(cb) {
  onCompleteCallback = cb;
}

export function stopAutoRefresh() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  state.active = false;
}

export function getAutoRefreshStatus() {
  return {
    active: state.active,
    intervalMinutes: state.intervalMinutes,
    lastRun: state.lastRun,
    lastSummary: state.lastSummary,
    isRefreshing,
  };
}
