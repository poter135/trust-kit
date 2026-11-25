import { test } from 'node:test';
import assert from 'node:assert/strict';

test('assertion fails', () => {
  assert.equal(1 + 1, 3);
});

test('throws at runtime', () => {
  null.boom();
});
