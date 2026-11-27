import { createHash } from 'node:crypto';
import { listProviders, providerKeys, providerModelEntries } from './providers.js';
import { fetchProviderModels, forwardChatCompletion } from './providerProxy.js';

const PROBE_TIMEOUT_MS = 12_000;
let results = new Map();
let pending = null;

function providerVersion(provider) {
  // Changes to a provider's URL, credentials, or models invalidate its old results.
  return createHash('sha256').update(JSON.stringify(provider)).digest('hex');
}

function modelRow(provider, display, state) {
  return { id: `${provider.name}/${display}`, type: 'text', source: 'provider', provider: provider.name, ...state };
}

function failureReason(status) {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'model_not_found';
  if (status === 429) return 'provider_rate_limited';
  return status ? `http_${status}` : 'network_error';
}

async function probeProviderModel(provider, model) {
  const start = Date.now();
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const capture = {
    statusCode: 200,
    body: null,
    json(body) { this.body = body; },
    status(code) { this.statusCode = code; return this; },
  };
  const request = {
    model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_tokens: 128,
  };
  await forwardChatCompletion(provider, request, capture, { signal });
  if (capture.statusCode === 400 && provider.type === 'openai'
      && /max_tokens.*(unsupported|not supported)|max_completion_tokens/i.test(capture.body?.error?.message || '')) {
    // Some OpenAI reasoning models require max_completion_tokens.
    const { max_tokens, ...retry } = request;
    capture.statusCode = 200;
    await forwardChatCompletion(provider, { ...retry, max_completion_tokens: max_tokens }, capture, { signal });
  }
  const choices = Array.isArray(capture.body?.choices) ? capture.body.choices : [];
  const available = capture.statusCode < 400 && choices.some(choice =>
    [choice?.message?.content, choice?.message?.reasoning_content].some(value => typeof value === 'string' && value.trim()));
  const reason = available ? null : signal.aborted ? 'timeout'
    : capture.statusCode >= 400 ? failureReason(capture.statusCode) : 'model_empty_response';
  return { available, latency: Date.now() - start, reason };
}

async function probeProvider(provider) {
  const declared = providerModelEntries(provider);
  if (declared.size) {
    const models = [];
    for (const [display, upstream] of declared) {
      models.push(modelRow(provider, display, await probeProviderModel(provider, upstream)));
    }
    return { models, lastProbed: Date.now() };
  }

  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const ids = await fetchProviderModels({ ...provider, api_keys: providerKeys(provider) }, { signal });
    const models = [...new Set(ids.filter(id => typeof id === 'string' && id.trim()))].map(id =>
      modelRow(provider, id, { type: 'unknown', available: null, latency: null, reason: 'provider_catalog_only' }));
    const error = models.length ? null : { provider: provider.name, reason: 'provider_catalog_empty' };
    return { models, error, lastProbed: Date.now() };
  } catch (error) {
    const reason = signal.aborted ? 'timeout' : error.status === 404 ? 'provider_catalog_unsupported' : failureReason(error.status);
    return { models: [], error: { provider: provider.name, reason }, lastProbed: Date.now() };
  }
}

function enabledProviders() {
  return listProviders().filter(provider => provider.enabled !== false);
}

export function refreshProviderModels() {
  if (pending) return pending;
  pending = Promise.all(enabledProviders().map(async provider => [
    providerVersion(provider), await probeProvider(provider),
  ])).then(entries => { results = new Map(entries); }).finally(() => { pending = null; });
  return pending;
}

export function getProviderModelsStatus() {
  const models = [];
  const errors = [];
  let lastProbed = 0;
  for (const provider of enabledProviders()) {
    const result = results.get(providerVersion(provider));
    if (!result) {
      for (const display of providerModelEntries(provider).keys()) {
        models.push(modelRow(provider, display, { available: null, latency: null, reason: 'not_probed' }));
      }
      continue;
    }
    models.push(...result.models);
    if (result.error) errors.push(result.error);
    lastProbed = Math.max(lastProbed, result.lastProbed);
  }
  return { models, errors, lastProbed, inProgress: Boolean(pending) };
}
