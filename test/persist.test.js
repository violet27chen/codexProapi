import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

// 以内存 Map 模拟 PostgREST（Supabase REST）：GET 返回全部行，POST 做 upsert。
function makeFakeFetch(store) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'GET') {
      const rows = [...store.entries()].map(([key, content]) => ({ key, content }));
      return { ok: true, status: 200, async text() { return JSON.stringify(rows); } };
    }
    if (init.method === 'POST') {
      const rows = JSON.parse(init.body);
      for (const r of rows) store.set(r.key, r.content);
      return { ok: true, status: 201, async text() { return ''; } };
    }
    return { ok: false, status: 400, async text() { return 'bad'; } };
  };
  return calls;
}

async function freshPersist(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // 查询串令 ESM 重新求值模块（持久化配置在模块加载时读取）
  const mod = await import(pathToFileURL(join(process.cwd(), 'src', 'persist.js')).href + '?t=' + Math.random());
  return mod;
}

test('persist: 云端模式 hydrate 写回本地，写入后 flush 推送到云端', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpx-persist-'));
  const accountsFile = join(dir, 'accounts.json');
  const store = new Map();
  // 预置云端已有的账号与配置
  store.set('accounts.json', JSON.stringify({ accounts: [{ account_id: 'acc1', refresh_token: 'rt-AAA' }] }));
  store.set('config.json', JSON.stringify({ api_key: 'sk-x', default_model: 'gpt-5-codex' }));
  makeFakeFetch(store);

  const p = await freshPersist({
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    SUPABASE_TABLE: 'codex_app_state',
    CODEX_DATA_DIR: dir,
    CODEX_ACCOUNTS_FILE: accountsFile,
  });

  assert.equal(p.enabled, true, '应识别为启用云端持久化');

  // 1) hydrate：从云端恢复到本地文件
  const res = await p.hydrateFromCloud();
  assert.equal(res.restored, 2, '应恢复 accounts + config 两个文件');
  assert.ok(existsSync(accountsFile), 'accounts.json 应被写回');
  assert.equal(JSON.parse(readFileSync(accountsFile, 'utf8')).accounts[0].refresh_token, 'rt-AAA');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).api_key, 'sk-x');

  // 2) 运行期：本地改了账号 -> queuePush + flushPending 应把新内容 upsert 到云端
  const newJson = JSON.stringify({ accounts: [{ account_id: 'acc1', refresh_token: 'rt-AAA' }, { account_id: 'acc2', refresh_token: 'rt-BBB' }] });
  writeFileSync(accountsFile, newJson, 'utf8');
  p.queuePush(accountsFile);
  const flushed = await p.flushPending();
  assert.equal(flushed.pushed, 1, '应推送 1 个脏文件');
  assert.equal(store.get('accounts.json'), newJson, '云端 accounts.json 应被更新为最新内容');

  // 3) 未知文件名应被忽略，不入队
  const other = join(dir, 'random.txt');
  writeFileSync(other, 'x', 'utf8');
  p.queuePush(other);
  const before = store.size;
  await p.flushPending();
  assert.equal(store.size, before, '未知文件不应写入云端');

  rmSync(dir, { recursive: true, force: true });
});

test('persist: 未配置 Supabase 时整体退化为 no-op', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpx-persist-off-'));
  let fetched = false;
  global.fetch = async () => { fetched = true; return { ok: true, status: 200, async text() { return '[]'; } }; };

  const p = await freshPersist({
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    SUPABASE_KEY: '',
    CODEX_DATA_DIR: dir,
    CODEX_ACCOUNTS_FILE: join(dir, 'accounts.json'),
  });

  assert.equal(p.enabled, false, '无密钥应禁用');
  const h = await p.hydrateFromCloud();
  assert.equal(h.enabled, false);
  p.queuePush(join(dir, 'accounts.json'));
  const f = await p.flushPending();
  assert.equal(f.pushed, 0);
  assert.equal(fetched, false, '禁用模式不应发起任何网络请求');

  rmSync(dir, { recursive: true, force: true });
});

test('persist: 云端表缺失时 hydrate 优雅失败（不抛、返回错误）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cpx-persist-404-'));
  global.fetch = async () => ({
    ok: false, status: 404,
    async text() { return JSON.stringify({ code: 'PGRST205', message: 'Could not find the table public.codex_app_state in the schema cache' }); },
  });
  const p = await freshPersist({
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
    SUPABASE_TABLE: 'codex_app_state',
    CODEX_DATA_DIR: dir,
    CODEX_ACCOUNTS_FILE: join(dir, 'accounts.json'),
  });
  const res = await p.hydrateFromCloud();
  assert.equal(res.enabled, true);
  assert.equal(res.restored, 0);
  assert.ok(res.error, '应带回错误信息但不抛异常');
  rmSync(dir, { recursive: true, force: true });
});
