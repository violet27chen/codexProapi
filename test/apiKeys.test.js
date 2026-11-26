import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('gateway authenticates independent client keys and stays protected after revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-api-keys-'));
  const configPath = join(dir, 'config.json');
  process.env.CODEX_DATA_DIR = dir;
  process.env.CODEX_ACCOUNTS_FILE = join(dir, 'accounts.json');
  process.env.ADMIN_PASSWORD = 'test-admin-password';
  const { app } = await import('../src/index.js');
  const { gatewayDay, recordGatewayRequest } = await import('../src/gatewayUsage.js');
  const server = app.listen(0, '127.0.0.1');
  const upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const usage = { prompt_tokens: 7, completion_tokens: 3 };
      if (JSON.parse(raw).stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.end('data: ' + JSON.stringify({ usage }) + '\r\n\r\ndata: [DONE]\r\n\r\n');
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [], usage }));
      }
    });
  }).listen(0, '127.0.0.1');
  try {
    await Promise.all([once(server, 'listening'), once(upstream, 'listening')]);
    const base = 'http://127.0.0.1:' + server.address().port;
    const auth = token => ({ Authorization: 'Bearer ' + token });
    const json = { 'Content-Type': 'application/json' };
    const keysPath = '/api/api-keys';
    const modelsPath = '/v1/models';

    assert.equal((await fetch(base + modelsPath)).status, 200);
    assert.equal((await fetch(base + '/API/API-KEYS/')).status, 401);
    assert.equal((await fetch(base + keysPath, { method: 'POST', headers: json, body: '{}' })).status, 401);
    const login = await fetch(base + '/api/admin/login', {
      method: 'POST', headers: json, body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const admin = { ...json, Cookie: login.headers.get('set-cookie').split(';')[0] };
    const create = body => fetch(base + keysPath, { method: 'POST', headers: admin, body: JSON.stringify(body) });
    const revoke = id => fetch(base + keysPath + '/' + id, { method: 'DELETE', headers: admin });

    writeFileSync(configPath, JSON.stringify({ api_key: 'test-legacy-key' }));
    assert.equal((await fetch(base + modelsPath, { headers: auth('test-legacy-key') })).status, 401);
    assert.equal((await fetch(base + modelsPath)).status, 401);
    const initialList = await (await fetch(base + keysPath, { headers: admin })).json();
    assert.deepEqual(initialList.keys, []);
    assert.equal(initialList.required, true);
    assert.equal((await create({ name: '  ', expires_in_days: 30 })).status, 400);
    assert.equal((await create({ name: 'Invalid expiry', expires_in_days: 1 })).status, 400);

    const created = await create({ name: ' Cursor ', expires_in_days: 30 });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const first = await created.json();
    const second = await (await create({ name: 'CI', expires_in_days: null })).json();
    assert.match(first.token, /^sk-cp-[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.token, second.token);
    assert.equal(first.key.name, 'Cursor');
    assert.equal(Date.parse(first.key.expires_at) - Date.parse(first.key.created_at), 30 * 86_400_000);
    assert.equal(second.key.expires_at, null);

    const saved = readFileSync(configPath, 'utf8');
    assert(!saved.includes(first.token) && !saved.includes(second.token));
    const config = JSON.parse(saved);
    assert(!Object.hasOwn(config, 'api_key'));
    const hash = config.api_keys.find(key => key.id === first.key.id).hash;
    for (const endpoint of [keysPath, '/api/settings', '/api/config']) {
      const body = await (await fetch(base + endpoint, { headers: admin })).text();
      assert(!body.includes(first.token) && !body.includes(second.token) && !body.includes(hash));
    }

    assert.equal((await fetch(base + '/V1/MODELS/')).status, 401);
    assert.equal((await fetch(base + modelsPath, { headers: auth(process.env.ADMIN_PASSWORD) })).status, 401);
    assert.equal((await fetch(base + modelsPath, { headers: auth(first.token) })).status, 200);
    assert.equal((await fetch(base + modelsPath, { headers: { 'x-api-key': second.token } })).status, 200);
    assert.equal((await fetch(base + '/api/providers', {
      method: 'POST', headers: admin, body: JSON.stringify({
        name: 'metered', type: 'openai', base_url: 'http://127.0.0.1:' + upstream.address().port,
        api_key: 'test-upstream-key', models: ['model'],
      }),
    })).status, 200);
    const completion = (token, stream) => fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { ...json, ...auth(token) }, body: JSON.stringify({
        model: 'metered/model', messages: [{ role: 'user', content: 'Test' }], stream,
      }),
    });
    assert.equal((await (await completion(first.token, false)).json()).usage.prompt_tokens, 7);
    assert.match(await (await completion(second.token, true)).text(), /\[DONE\]/);
    const today = gatewayDay();
    const month = today.slice(0, 7);
    const dayBefore = gatewayDay(new Date(Date.now() - 86_400_000));
    recordGatewayRequest(dayBefore, first.key.id, true, { prompt_tokens: 13, completion_tokens: 8 });
    const usage = async query => {
      const response = await fetch(base + '/api/usage/gateway?' + new URLSearchParams(query), { headers: admin });
      assert.equal(response.status, 200);
      return response.json();
    };
    const filtered = await usage({ period: 'day', date: today, key: first.key.id });
    assert.deepEqual(filtered.total, { requests: 2, succeeded: 2, input_tokens: 7, output_tokens: 3, images: 0 });
    assert.deepEqual(filtered.rows.map(row => row.key_id), [first.key.id]);
    assert.equal((await usage({ period: 'day', date: today })).total.input_tokens, 14);
    assert.equal((await usage({ period: 'day', date: dayBefore })).total.input_tokens, 13);
    assert.equal((await usage({ period: 'month', date: month })).total.input_tokens, dayBefore.startsWith(month) ? 27 : 14);
    assert.equal((await fetch(base + '/api/usage/gateway?date=2026-02-30', { headers: admin })).status, 400);
    assert.equal((await fetch(base + '/api/settings', {
      method: 'PATCH', headers: admin, body: JSON.stringify({ default_model: 'example-model' }),
    })).status, 200);
    assert.equal((await fetch(base + modelsPath, { headers: auth(first.token) })).status, 200);

    const updated = JSON.parse(readFileSync(configPath, 'utf8'));
    updated.api_keys.find(key => key.id === first.key.id).expires_at = new Date(0).toISOString();
    writeFileSync(configPath, JSON.stringify(updated));
    assert.equal((await fetch(base + modelsPath, { headers: auth(first.token) })).status, 401);
    const expiredList = await (await fetch(base + keysPath, { headers: admin })).json();
    assert.equal(expiredList.keys.find(key => key.id === first.key.id).status, 'expired');
    assert.equal((await revoke('legacy')).status, 404);
    assert.equal((await fetch(base + modelsPath, { headers: auth('test-legacy-key') })).status, 401);
    assert.equal((await fetch(base + modelsPath, { headers: auth(second.token) })).status, 200);
    assert.equal((await revoke(second.key.id)).status, 204);
    assert.equal((await revoke(second.key.id)).status, 204);
    assert.equal((await fetch(base + modelsPath, { headers: auth(second.token) })).status, 401);
    assert.equal((await fetch(base + modelsPath)).status, 401);
    const finalList = await (await fetch(base + keysPath, { headers: admin })).json();
    assert.equal(finalList.required, true);
    assert.equal(finalList.keys.find(key => key.id === second.key.id).status, 'revoked');
    assert.equal((await usage({ period: 'day', date: today, key: second.key.id })).total.input_tokens, 7);
    assert.equal((await fetch(base + '/api/settings', {
      method: 'PATCH', headers: admin, body: '{"api_key":"replacement"}',
    })).status, 400);

    delete process.env.ADMIN_PASSWORD;
    assert.equal((await create({ name: 'Unauthorized' })).status, 403);
    assert.equal((await fetch(base + '/api/config', { method: 'PUT', headers: json, body: '{"api_key":"replacement"}' })).status, 404);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
