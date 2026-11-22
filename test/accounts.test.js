import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addLocalCodexAccount } from '../src/accounts.js';

test('addLocalCodexAccount imports the local Codex session and refresh token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-'));
  const codexHome = join(dir, '.codex');
  const authPath = join(codexHome, 'auth.json');
  const accountsPath = join(dir, 'accounts.json');
  const previousAuthPath = process.env.CODEX_AUTH_PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousAccountsPath = process.env.CODEX_ACCOUNTS_FILE;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(authPath, JSON.stringify({
    email: 'local@example.com',
    tokens: {
      access_token: 'access-token',
      account_id: 'account-123',
      refresh_token: 'refresh-token',
    },
  }));
  process.env.CODEX_AUTH_PATH = '';
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_ACCOUNTS_FILE = accountsPath;

  try {
    assert.deepEqual(addLocalCodexAccount(), { ok: true });
    const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].name, 'local@example.com');
    assert.equal(accounts[0].account_id, 'account-123');
    assert.equal(accounts[0].refresh_token, 'refresh-token');
    assert.equal(accounts[0].source, 'local_codex');
  } finally {
    if (previousAuthPath === undefined) delete process.env.CODEX_AUTH_PATH;
    else process.env.CODEX_AUTH_PATH = previousAuthPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousAccountsPath === undefined) delete process.env.CODEX_ACCOUNTS_FILE;
    else process.env.CODEX_ACCOUNTS_FILE = previousAccountsPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addLocalCodexAccount explains how to authenticate when auth.json is missing', () => {
  const previousAuthPath = process.env.CODEX_AUTH_PATH;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_AUTH_PATH = '';
  process.env.CODEX_HOME = join(tmpdir(), 'codex-proapi-no-auth');

  try {
    assert.throws(addLocalCodexAccount, /请先运行 codex login/);
  } finally {
    if (previousAuthPath === undefined) delete process.env.CODEX_AUTH_PATH;
    else process.env.CODEX_AUTH_PATH = previousAuthPath;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
