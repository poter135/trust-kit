import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, TrustConfigError, ALWAYS_PROTECTED } from '../src/config.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fx = (name) => path.join(fixtures, name);

test('valid config loads runners', () => {
  const cfg = loadConfig(fx('valid'));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.runners[0].adapter, 'jest');
  assert.equal(cfg.runners[0].id, 'backend');
  assert.deepEqual(cfg.runners[0].testGlobs, ['test/**/*.test.ts']);
  assert.equal(cfg.evidence.outDir, '.trust/evidence');
  assert.equal(cfg.ledger.path, '.trust/ledger.md');
});

test('missing version throws TrustConfigError mentioning version', () => {
  assert.throws(() => loadConfig(fx('missing-version')), (err) => {
    assert.ok(err instanceof TrustConfigError);
    assert.match(err.message, /version/);
    return true;
  });
});

test('unknown adapter names field path and allowed values', () => {
  assert.throws(() => loadConfig(fx('bad-adapter')), (err) => {
    assert.ok(err instanceof TrustConfigError);
    assert.match(err.message, /runners\[0\]\.adapter/);
    for (const a of ['flutter', 'jest', 'node-test']) assert.ok(err.message.includes(a), `missing ${a}`);
    return true;
  });
});

test('protectedPaths always include trust-kit control files', () => {
  const cfg = loadConfig(fx('valid'));
  for (const p of ['trust.config.json', 'tools/trust-kit.version', '.trust/rules.json']) {
    assert.ok(cfg.protectedPaths.includes(p), `missing ${p}`);
  }
  assert.ok(cfg.protectedPaths.includes('ci/**'), 'user entries kept');
  assert.deepEqual([...ALWAYS_PROTECTED].sort(), ['.trust/rules.json', 'tools/trust-kit.version', 'trust.config.json']);
});

test('missing config file throws TrustConfigError with fix hint', () => {
  assert.throws(() => loadConfig(fx('does-not-exist')), (err) => {
    assert.ok(err instanceof TrustConfigError);
    assert.match(err.message, /trust\.config\.json/);
    return true;
  });
});
