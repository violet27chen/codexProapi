import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveJsonState } from './persist.js';

const usagePath = join(process.env.CODEX_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data'), 'gateway_usage.json');
const zone = 'Asia/Shanghai';
const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });

export function gatewayDay(date = new Date()) {
  return calendar.format(date);
}

function readUsage() {
  try {
    return JSON.parse(readFileSync(usagePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function counters() {
  return { requests: 0, succeeded: 0, input_tokens: 0, output_tokens: 0, images: 0 };
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function recordGatewayRequest(day, keyId, success, usage) {
  const history = readUsage();
  const byKey = history[day] ??= {};
  const bucket = byKey[keyId] ??= counters();
  bucket.requests++;
  if (success) bucket.succeeded++;
  bucket.input_tokens += count(usage?.prompt_tokens);
  bucket.output_tokens += count(usage?.completion_tokens);
  bucket.images += count(usage?.images);
  saveJsonState(usagePath, history);
}

export function getGatewayUsage(period, date, selectedKey, keys) {
  const history = readUsage();
  const names = new Map([
    ['anonymous', '未使用密钥'],
    ...keys.map(({ id, name, prefix }) => [id, name + ' · ' + prefix + '…']),
  ]);
  const total = counters();
  const rows = [];
  for (const day of Object.keys(history).sort().reverse()) {
    if (period === 'day' ? day !== date : !day.startsWith(date + '-')) continue;
    for (const [keyId, usage] of Object.entries(history[day])) {
      if (selectedKey && keyId !== selectedKey) continue;
      rows.push({ day, key_id: keyId, key_name: names.get(keyId) || '历史密钥', ...usage });
      for (const field of Object.keys(total)) total[field] += usage[field];
    }
  }
  return {
    date, period, total, rows, time_zone: zone,
    keys: Array.from(names, ([id, label]) => ({ id, label })),
  };
}
