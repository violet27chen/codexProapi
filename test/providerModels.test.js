import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('model refresh returns and probes provider models alongside Codex models', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-provider-models-'));
  process.env.CODEX_DATA_DIR = dir;
  process.env.CODEX_ACCOUNTS_FILE = join(dir, 'accounts.json');
  delete process.env.ADMIN_PASSWORD;
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { app } = await import('../src/index.js');
  const { addAccount } = await import('../src/accounts.js');
  const { addProvider, updateProvider } = await import('../src/providers.js');
  const upstream = 'https://provider.example';
  addProvider({ name: 'manual', base_url: upstream + '/manual/v1', models: ['chat=org/real', 'missing'] });
  addProvider({ name: 'catalog', base_url: upstream + '/catalog/v1' });
  addProvider({ name: 'no-directory', base_url: upstream + '/no-directory/v1' });
  addProvider({ name: 'disabled', base_url: upstream + '/disabled/v1', models: ['off'], enabled: false });

  const providerRequests = [];
  const localFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0') {
      return Response.json({ models: [{ slug: 'codex-test', visibility: 'list' }] });
    }
    if (url === 'https://chatgpt.com/backend-api/codex/responses') {
      return new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    }
    if (url.startsWith(upstream)) {
      providerRequests.push([new URL(url).pathname, options.body && JSON.parse(options.body).model]);
      if (url.endsWith('/catalog/v1/models')) return Response.json({ data: [{ id: 'org/found' }] });
      if (url.endsWith('/no-directory/v1/models')) return new Response('No directory', { status: 404 });
      if (url.endsWith('/manual/v1/chat/completions') && JSON.parse(options.body).model === 'org/real') {
        return Response.json({ choices: [{ message: { content: 'OK' } }] });
      }
      return new Response('Unknown model', { status: 404 });
    }
    return localFetch(url, options);
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = async (path, method = 'GET') => {
    const response = await fetch(origin + path, { method });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await get('/api/models');
  assert.deepEqual(first.models.map(model => [model.id, model.available]), [['manual/chat', null], ['manual/missing', null]]);
  assert.equal(providerRequests.length, 0);
  const onlyProviders = await get('/api/models/refresh', 'POST');
  assert.deepEqual(onlyProviders.models.map(model => [model.id, model.available, model.reason]), [
    ['manual/chat', true, null],
    ['manual/missing', false, 'model_not_found'],
    ['catalog/org/found', null, 'provider_catalog_only'],
  ]);
  assert.deepEqual(onlyProviders.providerCatalogErrors, [{ provider: 'no-directory', reason: 'provider_catalog_unsupported' }]);
  assert.deepEqual((await get('/api/models')).models, onlyProviders.models);
  assert(providerRequests.some(([path, model]) => path === '/manual/v1/chat/completions' && model === 'org/real'));
  assert(!providerRequests.some(([path]) => path.includes('/disabled/') || path === '/catalog/v1/chat/completions'));
  assert.deepEqual((await get('/v1/models')).data.map(model => model.id), ['manual/chat', 'manual/missing']);

  addAccount({ name: 'test', access_token: 'test-token', account_id: 'test-account' });
  const [mixed, concurrent] = await Promise.all([get('/api/models/refresh', 'POST'), get('/api/models/refresh', 'POST')]);
  assert.deepEqual(mixed.models, concurrent.models);
  assert.deepEqual(mixed.models.filter(model => model.available === true).map(model => model.id), ['codex-test', 'manual/chat']);
  assert.equal(providerRequests.filter(([path, model]) => path === '/manual/v1/chat/completions' && model === 'org/real').length, 2);

  updateProvider(0, { base_url: upstream + '/changed/v1' });
  const afterEdit = await get('/api/models');
  assert.equal(afterEdit.models.find(model => model.id === 'manual/chat').available, null);
});
