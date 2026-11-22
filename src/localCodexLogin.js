import { spawn } from 'node:child_process';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_LENGTH = 2000;

let child = null;
let timeout = null;
let state = { status: 'idle', message: null, output: '' };

export function getLocalCodexLoginStatus() {
  return { ...state };
}

export function startLocalCodexLogin(onComplete) {
  if (child || state.status === 'importing') return getLocalCodexLoginStatus();

  state = { status: 'starting', message: null, output: '' };
  let finalized = false;
  let timedOut = false;

  const appendOutput = (chunk) => {
    const text = chunk.toString()
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted token]')
      .replace(/\b(access_token|refresh_token|api_key)\s*[:=]\s*["']?[^ \r\n"']+/gi, '$1=[redacted]');
    state = {
      ...state,
      output: `${state.output}${text}`.slice(-MAX_OUTPUT_LENGTH),
    };
  };

  const finish = async (error) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(timeout);
    timeout = null;
    child = null;

    if (error) {
      state = { ...state, status: 'error', message: error };
      return;
    }

    state = { ...state, status: 'importing', message: 'Codex 已登录，正在添加账号' };
    try {
      await onComplete();
      state = { ...state, status: 'complete', message: 'Codex 登录完成，账号已添加' };
    } catch (completionError) {
      state = { ...state, status: 'error', message: completionError.message };
    }
  };

  try {
    child = spawn('codex', ['login'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    child = null;
    state = {
      status: 'error',
      message: `无法启动 Codex CLI：${error.message}`,
      output: '',
    };
    return getLocalCodexLoginStatus();
  }

  child.stdout.on('data', appendOutput);
  child.stderr.on('data', appendOutput);
  child.once('error', (error) => {
    const message = error.code === 'ENOENT'
      ? '找不到 Codex CLI，请安装 Codex 并确认 codex 命令可用'
      : `无法启动 Codex CLI：${error.message}`;
    void finish(message);
  });
  child.once('close', (code, signal) => {
    if (timedOut) {
      void finish('Codex 登录超时，请重试');
    } else if (code !== 0) {
      void finish(`Codex 登录未成功（退出码 ${code ?? signal ?? '未知'}）`);
    } else {
      void finish(null);
    }
  });

  timeout = setTimeout(() => {
    timedOut = true;
    child?.kill();
  }, LOGIN_TIMEOUT_MS);
  timeout.unref();
  state = { ...state, status: 'running', message: 'Codex 正在启动浏览器，请完成登录' };
  return getLocalCodexLoginStatus();
}
