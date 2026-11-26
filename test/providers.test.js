import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

async function freshProviders() {
  const dir = mkdtempSync(join(tmpdir(), 'cpx-prov-'));
  process.env.CODEX_DATA_DIR = dir;
  process.env.CODEX_ACCOUNTS_FILE = join(dir, 'accounts.json');
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_KEY;
  const m = await import(pathToFileURL(join(process.cwd(), 'src', 'providers.js')).href + '?t=' + Math.random());
  return { m, dir };
}

test('providers: 增删改查 + key 脱敏', async () => {
  const { m, dir } = await freshProviders();
  m.addProvider({ name: 'DeepSeek', type: 'openai', base_url: 'https://api.deepseek.com/v1', api_key: 'sk-abcdef123456', models: ['deepseek-chat'] });
  const list = m.listProvidersForApi();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'deepseek'); // 规范化小写
  assert.ok(list[0].keyMask.endsWith('3456'));
  assert.ok(!JSON.stringify(list).includes('sk-abcdef123456'), '不应泄露完整 key');

  m.updateProvider(0, { api_key: 'sk-ZZZZ9999' });
  assert.ok(m.listProvidersForApi()[0].keyMask.endsWith('9999'));

  m.setProviderEnabled(0, false);
  assert.equal(m.listProvidersForApi()[0].enabled, false);

  m.deleteProvider(0);
  assert.equal(m.listProvidersForApi().length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('providers: 重名/非法名/非法 base_url 被拒', async () => {
  const { m, dir } = await freshProviders();
  m.addProvider({ name: 'open', type: 'openai', base_url: 'https://a.com/v1', api_key: 'k' });
  assert.throws(() => m.addProvider({ name: 'open', base_url: 'https://b.com/v1', api_key: 'k' }), /同名/);
  assert.throws(() => m.addProvider({ name: 'codex', base_url: 'https://b.com/v1', api_key: 'k' }), /保留/);
  assert.throws(() => m.addProvider({ name: 'x', base_url: 'ftp://bad', api_key: 'k' }), /http/);
  rmSync(dir, { recursive: true, force: true });
});

test('providers: 别名映射 显示名=真实id（两段调用，转发成真实 id）', async () => {
  const { m, dir } = await freshProviders();
  m.addProvider({ name: 'cantrustai', type: 'openai', base_url: 'https://api.cantrustai.xyz/v1', api_key: 'k', models: ['deepseek-v4.1-flash=deepseek/deepseek-v4.1-flash'] });
  // 客户端只写两段 -> 路由解析出真实上游 id（三段）
  const r = m.resolveRouting('cantrustai/deepseek-v4.1-flash');
  assert.equal(r.provider.name, 'cantrustai');
  assert.equal(r.model, 'deepseek/deepseek-v4.1-flash');
  // 展示/聚合列表用显示名（两段），不暴露真实 id
  const ids = m.listProviderModelIds().map((x) => x.id);
  assert.deepEqual(ids, ['cantrustai/deepseek-v4.1-flash']);
  // 未声明别名 -> 原样透传
  assert.equal(m.resolveRouting('cantrustai/some-other').model, 'some-other');
  rmSync(dir, { recursive: true, force: true });
});
  const { m, dir } = await freshProviders();
  m.addProvider({ name: 'open', type: 'openai', base_url: 'https://a.com/v1', api_key: 'k' });
  m.addProvider({ name: 'openrouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', api_key: 'k' });

  // 无前缀 -> 走内置 Codex（null）
  assert.equal(m.resolveRouting('gpt-5-codex'), null);
  // open/ 命中 open
  let r = m.resolveRouting('open/foo');
  assert.equal(r.provider.name, 'open');
  assert.equal(r.model, 'foo');
  // openrouter/ 最长匹配优先于 open/
  r = m.resolveRouting('openrouter/meta-llama/Llama-3');
  assert.equal(r.provider.name, 'openrouter');
  assert.equal(r.model, 'meta-llama/Llama-3');
  // 未知前缀 -> null
  assert.equal(m.resolveRouting('unknown/model'), null);
  rmSync(dir, { recursive: true, force: true });
});
