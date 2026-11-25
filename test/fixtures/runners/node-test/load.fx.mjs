import { test } from 'node:test';
import { missing } from './does-not-exist.mjs';

test('never runs', () => {
  missing();
});
