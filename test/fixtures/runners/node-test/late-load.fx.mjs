import { test } from 'node:test';
import assert from 'node:assert/strict';

test('registered before the failing import', () => {
  assert.equal(1 + 1, 2);
});

await import('./missing.mjs');
