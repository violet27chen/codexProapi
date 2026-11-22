import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelCatalog } from '../src/modelCatalog.js';

test('parseModelCatalog returns unique visible model IDs', () => {
  const ids = parseModelCatalog({
    models: [
      { slug: 'model-new', visibility: 'list' },
      { slug: 'model-hidden', visibility: 'hide' },
      { slug: 'model-new', visibility: 'list' },
      { slug: 'invalid/model', visibility: 'list' },
      { slug: 'model-unlisted' },
    ],
  });

  assert.deepEqual(ids, ['model-new']);
});

test('parseModelCatalog rejects an invalid catalog response', () => {
  assert.throws(() => parseModelCatalog({}), /缺少 models 数组/);
});
