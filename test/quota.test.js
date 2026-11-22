import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexUsage } from '../src/quota.js';

test('normalizeCodexUsage maps paid plan limits to five-hour and weekly quotas', () => {
  const usage = normalizeCodexUsage({
    plan_type: 'chatgpt_pro',
    rate_limit: {
      primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
      secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
    },
  });

  assert.equal(usage.plan_label, 'Pro');
  assert.equal(usage.is_member, true);
  assert.equal(usage.quota.five_hour.remaining_pct, 72);
  assert.equal(usage.quota.weekly.remaining_pct, 55);
  assert.equal(usage.quota.monthly, null);
});

test('normalizeCodexUsage maps free plan limits to the monthly quota only', () => {
  const usage = normalizeCodexUsage({
    plan_type: 'free',
    rate_limit: {
      primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
      monthly_window: { used_percent: 35, limit_window_seconds: 2_592_000 },
    },
  });

  assert.equal(usage.plan_label, 'Free');
  assert.equal(usage.is_member, false);
  assert.equal(usage.quota.five_hour, null);
  assert.equal(usage.quota.weekly, null);
  assert.equal(usage.quota.monthly.remaining_pct, 65);
});

test('normalizeCodexUsage extracts model-specific quotas without fabricating values', () => {
  const usage = normalizeCodexUsage({
    plan_type: 'chatgpt_pro',
    additional_rate_limits: [
      {
        limit_name: 'gpt-5-codex',
        rate_limit: {
          primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_800_100_000 },
        },
      },
    ],
  });

  assert.deepEqual(
    usage.model_quotas.map((item) => ({
      model: item.model,
      remaining_pct: item.remaining_pct,
    })),
    [{ model: 'gpt-5-codex', remaining_pct: 75 }],
  );
});
