import { test } from 'node:test';
import { createRequire } from 'node:module';

test('imports a module that does not exist yet', async () => {
  await import('./does-not-exist-yet.mjs');
});

test('requires a module that does not exist yet', () => {
  createRequire(import.meta.url)('./does-not-exist-yet.cjs');
});
