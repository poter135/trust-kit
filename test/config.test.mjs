import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
  assert.deepEqual([...ALWAYS_PROTECTED].sort(), ['.github/workflows/**', '.trust/rules.json', 'tools/trust-kit.version', 'trust.config.json']);
});

test('missing config file throws TrustConfigError with fix hint', () => {
  assert.throws(() => loadConfig(fx('does-not-exist')), (err) => {
    assert.ok(err instanceof TrustConfigError);
    assert.match(err.message, /trust\.config\.json/);
    return true;
  });
});

/** Writes a config with one node-test runner extended by `extra` into a temp dir and loads it. */
function loadWithRunner(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'trust.config.json'), JSON.stringify({
      version: 1,
      runners: [{ id: 'u', adapter: 'node-test', cwd: '.', testGlobs: ['t/**'], ...extra }],
      evidence: { outDir: 'e', screensDir: 's' }, ledger: { path: 'l' },
    }));
    return loadConfig(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('runners[].setup: list of argv arrays is kept; absent stays absent', () => {
  assert.deepEqual(loadWithRunner({ setup: [['npm', 'ci'], ['node', 'x.js']] }).runners[0].setup, [['npm', 'ci'], ['node', 'x.js']]);
  assert.equal('setup' in loadWithRunner({}).runners[0], false);
});

test('runners[].setup: bad shapes are rejected naming the field path', () => {
  const cases = [
    [{ setup: 'npm ci' }, /runners\[0\]\.setup\b/],
    [{ setup: ['npm', 'ci'] }, /runners\[0\]\.setup\[0\]/],
    [{ setup: [[]] }, /runners\[0\]\.setup\[0\]/],
    [{ setup: [['npm', 1]] }, /runners\[0\]\.setup\[0\]\[1\]/],
    [{ setup: [['npm', '']] }, /runners\[0\]\.setup\[0\]\[1\]/],
  ];
  for (const [extra, re] of cases) {
    assert.throws(() => loadWithRunner(extra), (err) => {
      assert.ok(err instanceof TrustConfigError, String(err));
      assert.match(err.message, re);
      return true;
    }, JSON.stringify(extra));
  }
});
