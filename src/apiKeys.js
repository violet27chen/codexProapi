import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';

const DAY_MS = 86_400_000;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function keyStatus(key, now) {
  if (key.revoked_at) return 'revoked';
  if (key.expires_at && Date.parse(key.expires_at) <= now) return 'expired';
  return 'active';
}

function publicKey(key, now = Date.now()) {
  const { id, name, prefix, created_at, expires_at } = key;
  return { id, name, prefix, created_at, expires_at, status: keyStatus(key, now) };
}

export function requiresApiKey(config) {
  return config.api_key_required || config.api_keys.length > 0;
}

export function findApiKey(config, token, now = Date.now()) {
  if (!token?.startsWith('sk-cp-')) return null;

  const candidate = digest(token);
  return config.api_keys.find(key => {
    return keyStatus(key, now) === 'active' && timingSafeEqual(candidate, Buffer.from(key.hash, 'hex'));
  }) || null;
}

export function apiKeysRouter({ loadConfig, saveConfig, isAdminConfigured }) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!isAdminConfigured()) {
      return res.status(403).json({ error: '请先在服务端配置 ADMIN_PASSWORD，再登录管理 API Key。' });
    }
    next();
  });

  router.get('/', (_req, res) => {
    const config = loadConfig();
    const now = Date.now();
    const keys = config.api_keys.map(key => publicKey(key, now));
    res.json({ keys, required: requiresApiKey(config) });
  });

  router.post('/', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const expiresInDays = req.body?.expires_in_days;
    if (!name || name.length > 64) {
      return res.status(400).json({ error: '请输入 1 到 64 个字符的 Key 名称。' });
    }
    if (expiresInDays != null && ![30, 90].includes(expiresInDays)) {
      return res.status(400).json({ error: '请选择 30 天、90 天或永不过期。' });
    }

    const config = loadConfig();
    const token = 'sk-cp-' + randomBytes(32).toString('base64url');
    const now = Date.now();
    const key = {
      id: randomUUID(),
      name,
      prefix: token.slice(0, 14),
      hash: digest(token).toString('hex'),
      created_at: new Date(now).toISOString(),
      expires_at: expiresInDays == null ? null : new Date(now + expiresInDays * DAY_MS).toISOString(),
      revoked_at: null,
    };
    config.api_keys.unshift(key);
    config.api_key_required = true;
    saveConfig(config);
    res.status(201).json({ key: publicKey(key, now), token });
  });

  router.delete('/:id', (req, res) => {
    const config = loadConfig();
    const key = config.api_keys.find(key => key.id === req.params.id);
    if (!key) return res.status(404).json({ error: '找不到该 API Key。' });
    key.revoked_at ||= new Date().toISOString();
    // Revocation must never reopen the gateway to unauthenticated requests.
    config.api_key_required = true;
    saveConfig(config);
    res.sendStatus(204);
  });

  router.use((err, _req, res, _next) => {
    console.error('[api-keys] 配置读写失败:', err.code || err.message);
    res.status(500).json({ error: '无法读取或保存 API Key 配置。' });
  });
  return router;
}
