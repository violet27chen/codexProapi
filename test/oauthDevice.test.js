import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDeviceAuth, pollDeviceAuthOnce } from '../src/oauth.js';

const realFetch = globalThis.fetch;

function jsonResp(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('startDeviceAuth 归一化 OpenAI usercode 响应', async () => {
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /deviceauth\/usercode$/);
    const body = JSON.parse(opts.body);
    assert.equal(body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
    return jsonResp({ device_auth_id: 'd1', user_code: 'ABCD-1234', interval: '5', expires_at: '2099-01-01T00:00:00+00:00' });
  };
  const r = await startDeviceAuth();
  assert.deepEqual(
    { id: r.device_auth_id, code: r.user_code, verify: r.verification_uri, interval: r.interval },
    { id: 'd1', code: 'ABCD-1234', verify: 'https://auth.openai.com/codex/device', interval: 5 }
  );
});

test('startDeviceAuth 地区受限时抛出 OpenAI 原始错误', async () => {
  globalThis.fetch = async () => jsonResp({ error: { code: 'unsupported_country_region_territory', message: 'Country, region, or territory not supported' } }, 403);
  await assert.rejects(() => startDeviceAuth(), /Country, region, or territory not supported/);
});

test('pollDeviceAuthOnce: pending', async () => {
  globalThis.fetch = async (url) => {
    assert.match(String(url), /deviceauth\/token$/);
    return jsonResp({ error: { code: 'deviceauth_authorization_pending', message: 'Device authorization is pending.' } }, 403);
  };
  const r = await pollDeviceAuthOnce({ device_auth_id: 'd1', user_code: 'ABCD-1234' });
  assert.equal(r.status, 'pending');
});

test('pollDeviceAuthOnce: authorization_code -> oauth/token 换 token 成功', async () => {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/deviceauth/token')) return jsonResp({ authorization_code: 'ac1', code_verifier: 'cv1' });
    if (String(url).endsWith('/oauth/token')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.grant_type, 'authorization_code');
      assert.equal(body.code, 'ac1');
      assert.equal(body.code_verifier, 'cv1');
      return jsonResp({
        access_token: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct-9' })).toString('base64url') + '.s',
        refresh_token: 'rt-1',
        expires_in: 3600,
      });
    }
    return jsonResp({}, 404);
  };
  const r = await pollDeviceAuthOnce({ device_auth_id: 'd1', user_code: 'ABCD-1234' });
  assert.equal(r.status, 'success');
  assert.equal(r.refresh_token, 'rt-1');
  assert.equal(r.account_id, 'acct-9');
});

test('pollDeviceAuthOnce: 直接返回 access_token 也能识别', async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes('/deviceauth/token')) return jsonResp({ access_token: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ sub: 'u-1' })).toString('base64url') + '.s', refresh_token: 'rt-2' });
    return jsonResp({}, 404);
  };
  const r = await pollDeviceAuthOnce({ device_auth_id: 'd1', user_code: 'ABCD-1234' });
  assert.equal(r.status, 'success');
  assert.equal(r.refresh_token, 'rt-2');
  assert.equal(r.account_id, 'u-1');
});

test('pollDeviceAuthOnce: access_denied 透传为 error', async () => {
  globalThis.fetch = async () => jsonResp({ error: { code: 'access_denied', message: 'Device authorization was denied.' } }, 400);
  const r = await pollDeviceAuthOnce({ device_auth_id: 'd1', user_code: 'ABCD-1234' });
  assert.equal(r.status, 'error');
  assert.match(r.message, /denied/);
});
