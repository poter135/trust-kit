import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getRunner } from '../../src/runners/index.mjs';

test('getRunner returns a runner for each supported adapter', () => {
  for (const id of ['flutter', 'jest', 'node-test']) {
    assert.equal(typeof getRunner(id).run, 'function', id);
  }
});

test('getRunner rejects unknown adapters with the supported list', () => {
  assert.throws(() => getRunner('vitest'), /unknown adapter "vitest".*flutter, jest, node-test/);
});
