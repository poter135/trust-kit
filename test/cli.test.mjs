import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');

test('unknown subcommand exits 2 and lists available subcommands', () => {
  const r = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nope/);
  assert.match(r.stderr, /config/);
});

test('missing subcommand exits 2', () => {
  const r = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
