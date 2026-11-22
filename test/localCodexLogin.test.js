import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getLocalCodexLoginStatus,
  startLocalCodexLogin,
} from '../src/localCodexLogin.js';

async function waitForLoginToFinish() {
  const deadline = Date.now() + 3000;
  let status;
  do {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = getLocalCodexLoginStatus();
  } while (['starting', 'running', 'importing'].includes(status.status) && Date.now() < deadline);
  return status;
}

test('local Codex login reports a missing CLI instead of adding an account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-path-'));
  const previousPath = process.env.PATH;
  process.env.PATH = dir;

  try {
    const started = startLocalCodexLogin(() => {
      assert.fail('account import must not run when the CLI cannot start');
    });
    assert.ok(['starting', 'running'].includes(started.status));

    const status = await waitForLoginToFinish();
    assert.equal(status.status, 'error');
    assert.match(status.message, /Codex CLI|Codex 登录未成功/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local Codex login captures redacted CLI output and imports after success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-proapi-cli-'));
  const executable = join(dir, 'codex');
  const previousPath = process.env.PATH;
  writeFileSync(executable, '#!/bin/sh\nprintf "Waiting for browser login\\nBearer hidden-value\\n"\n');
  chmodSync(executable, 0o755);
  process.env.PATH = dir;
  let imported = false;

  try {
    const started = startLocalCodexLogin(() => { imported = true; });
    assert.ok(['starting', 'running'].includes(started.status));

    const status = await waitForLoginToFinish();
    assert.equal(status.status, 'complete');
    assert.equal(imported, true);
    assert.match(status.output, /Waiting for browser login/);
    assert.doesNotMatch(status.output, /hidden-value/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
