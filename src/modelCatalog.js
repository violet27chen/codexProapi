export function parseModelCatalog(payload) {
  if (!Array.isArray(payload?.models)) {
    throw new Error('模型目录响应格式无效：缺少 models 数组');
  }

  const ids = [];
  const seen = new Set();
  for (const model of payload.models) {
    if (!model || model.visibility !== 'list' || typeof model.slug !== 'string') continue;
    const id = model.slug.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
