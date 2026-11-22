import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoundRobinProvider } from '../src/auth.js';
import { markAccountUnavailable, unmarkAccountUnavailable } from '../src/accountStatus.js';

test('createRoundRobinProvider rotates through accounts for retries', () => {
  const provider = createRoundRobinProvider([
    { accountId: 'round-robin-a', accessToken: 'token-a' },
    { accountId: 'round-robin-b', accessToken: 'token-b' },
  ]);

  assert.equal(provider().accountId, 'round-robin-a');
  assert.equal(provider().accountId, 'round-robin-b');
  assert.equal(provider().accountId, 'round-robin-a');
});

test('createRoundRobinProvider skips accounts marked unavailable', () => {
  const auths = [
    { accountId: 'round-robin-unavailable', accessToken: 'token-a' },
    { accountId: 'round-robin-healthy', accessToken: 'token-b' },
  ];
  markAccountUnavailable(auths[0].accountId);
  try {
    const provider = createRoundRobinProvider(auths);
    assert.equal(provider().accountId, auths[1].accountId);
  } finally {
    unmarkAccountUnavailable(auths[0].accountId);
  }
});
