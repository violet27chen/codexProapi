import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addAccount,
  addLocalCodexAccount,
  batchAddAccounts,
  listAccountsForApi,
  loadAccountsForProxy,
  setAccountBlocked,
  updateAccount,
} from '../src/accounts.js';

test('blocked accounts persist and are excluded from proxy account loading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-'));
  const accountsPath = join(dir, 'accounts.json');
  const previousAccountsPath = process.env.CODEX_ACCOUNTS_FILE;
  process.env.CODEX_ACCOUNTS_FILE = accountsPath;

  try {
    addAccount({ access_token: 'access-1', account_id: 'account-1' });
    addAccount({ access_token: 'access-2', account_id: 'account-2' });

    assert.deepEqual(setAccountBlocked(0, true), { ok: true, blocked: true });
    assert.deepEqual(loadAccountsForProxy().map((account) => account.accountId), ['account-2']);
    assert.equal(listAccountsForApi().accounts[0].blocked, true);

    setAccountBlocked(0, false);
    assert.deepEqual(loadAccountsForProxy().map((account) => account.accountId), ['account-1', 'account-2']);
    assert.throws(() => setAccountBlocked(2, true), /未找到指定账号/);
  } finally {
    if (previousAccountsPath === undefined) delete process.env.CODEX_ACCOUNTS_FILE;
    else process.env.CODEX_ACCOUNTS_FILE = previousAccountsPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addAccount updates an existing account instead of duplicating it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-'));
  const accountsPath = join(dir, 'accounts.json');
  const previousAccountsPath = process.env.CODEX_ACCOUNTS_FILE;
  process.env.CODEX_ACCOUNTS_FILE = accountsPath;

  try {
    assert.deepEqual(addAccount({
      name: '旧名称',
      access_token: 'old-access',
      account_id: 'account-123',
      refresh_token: 'old-refresh',
      proxy: 'http://old-proxy',
    }), { ok: true, updated: false, duplicate: false, index: 0 });
    assert.deepEqual(addAccount({
      name: '新名称',
      access_token: 'new-access',
      account_id: 'account-123',
      refresh_token: 'new-refresh',
    }), { ok: true, updated: true, duplicate: true, index: 0 });

    const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).accounts;
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].name, '新名称');
    assert.equal(accounts[0].access_token, 'new-access');
    assert.equal(accounts[0].refresh_token, 'new-refresh');
    assert.equal(accounts[0].proxy, 'http://old-proxy');
  } finally {
    if (previousAccountsPath === undefined) delete process.env.CODEX_ACCOUNTS_FILE;
    else process.env.CODEX_ACCOUNTS_FILE = previousAccountsPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateAccount can edit account fields and rejects duplicate account IDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-'));
  const accountsPath = join(dir, 'accounts.json');
  const previousAccountsPath = process.env.CODEX_ACCOUNTS_FILE;
  process.env.CODEX_ACCOUNTS_FILE = accountsPath;
  writeFileSync(accountsPath, JSON.stringify({ accounts: [
    { name: '一号', access_token: 'access-1', account_id: 'account-1', refresh_token: 'refresh-1' },
    { name: '二号', access_token: 'access-2', account_id: 'account-2' },
  ] }));

  try {
    updateAccount(0, { name: '新一号', account_id: 'account-1', proxy: 'http://proxy:8080' });
    let accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).accounts;
    assert.equal(accounts[0].name, '新一号');
    assert.equal(accounts[0].proxy, 'http://proxy:8080');
    assert.equal(accounts[0].access_token, 'access-1');
    assert.equal(accounts[0].refresh_token, 'refresh-1');
    assert.throws(() => updateAccount(0, { account_id: 'account-2' }), /已存在/);
  } finally {
    if (previousAccountsPath === undefined) delete process.env.CODEX_ACCOUNTS_FILE;
    else process.env.CODEX_ACCOUNTS_FILE = previousAccountsPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('batchAddAccounts updates duplicate accounts and skips duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-'));
  const accountsPath = join(dir, 'accounts.json');
  const previousAccountsPath = process.env.CODEX_ACCOUNTS_FILE;
  process.env.CODEX_ACCOUNTS_FILE = accountsPath;

  try {
    const result = batchAddAccounts([
      { name: '一号', access_token: 'access-1', account_id: 'account-1', refresh_token: 'refresh-1' },
      { name: '一号新令牌', access_token: 'access-1b', account_id: 'account-1', refresh_token: 'refresh-1b' },
      { name: '二号', access_token: 'access-2', account_id: 'account-2', refresh_token: 'refresh-2' },
    ]);
    assert.deepEqual(result, { ok: true, imported: 2, updated: 1 });
    const accounts = JSON.parse(readFileSync(accountsPath, 'utf8')).accounts;
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0].access_token, 'access-1b');
    assert.equal(accounts[0].refresh_token, 'refresh-1b');
  } finally {
    if (previousAccountsPath === undefined) delete process.env.CODEX_ACCOUNTS_FILE;
    else process.env.CODEX_ACCOUNTS_FILE = previousAccountsPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.equal(addLocalCodexAccount().ok, true);
    assert.equal(addLocalCodexAccount().duplicate, true);
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
