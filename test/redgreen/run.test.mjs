import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRedGreen } from '../../src/redgreen/run.mjs';
import { makeRepo, commit, writeFiles, nodeTestConfig, extraWorktrees } from './helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'trust-kit.mjs');
const ADD_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "import { add } from '../src/add.mjs';\ntest('add sums', () => { assert.equal(add(1, 2), 3); });\n";

/** base: add() is wrong. head: add() fixed plus a new test. */
function bugfixRepo() {
  const dir = makeRepo();
  const base = commit(dir, { 'trust.config.json': nodeTestConfig(), 'src/add.mjs': 'export const add = (a, b) => a - b;\n' });
  const head = commit(dir, { 'src/add.mjs': 'export const add = (a, b) => a + b;\n', 'test/add.test.mjs': ADD_TEST });
  return { dir, base, head };
}

test('bug fix with a new test that fails on base by assertion → valid_red; no temp worktree left', async () => {
  const { dir, base, head } = bugfixRepo();
  try {
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.equal(rep.verdict, 'valid_red', JSON.stringify(rep, null, 2));
    assert.equal(rep.schema, 'trust-kit/red-green@1');
    assert.equal(rep.base, base);
    assert.equal(rep.head, head);
    assert.ok(!Number.isNaN(Date.parse(rep.generatedAt)));
    assert.deepEqual(rep.runners, [{ id: 'unit', tests: [
      { file: 'test/add.test.mjs', name: 'add sums', base: 'behavior_fail', head: 'pass' }] }]);
    assert.deepEqual(extraWorktrees(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('head test importing a file base does not have → invalid_red; no temp worktree left', async () => {
  const dir = makeRepo();
  try {
    const base = commit(dir, { 'trust.config.json': nodeTestConfig(), 'src/add.mjs': 'export const add = (a, b) => a + b;\n' });
    const head = commit(dir, {
      'src/mul.mjs': 'export const mul = (a, b) => a * b;\n',
      'test/mul.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
        + "import { mul } from '../src/mul.mjs';\ntest('mul', () => { assert.equal(mul(2, 3), 6); });\n",
    });
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.equal(rep.verdict, 'invalid_red', JSON.stringify(rep, null, 2));
    assert.deepEqual(extraWorktrees(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uncommitted changes in the working tree do not affect the head run', async () => {
  const { dir, base, head } = bugfixRepo();
  try {
    writeFiles(dir, { 'src/add.mjs': 'export const add = () => 0;\n' });
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.equal(rep.verdict, 'valid_red', JSON.stringify(rep, null, 2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('temp worktrees are removed even when the run throws', async () => {
  const { dir, base } = bugfixRepo();
  try {
    // head has no trust.config.json → loading config fails after the head worktree exists
    const head = commit(dir, { 'trust.config.json': null, 'test/add.test.mjs': ADD_TEST });
    await assert.rejects(runRedGreen({ repoRoot: dir, base, head }), /trust\.config\.json/);
    assert.deepEqual(extraWorktrees(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI red-green: --out writes the report with full SHAs, verdict on stderr, exit 0', () => {
  const { dir, base, head } = bugfixRepo();
  try {
    const out = path.join(dir, 'out', 'rg.json');
    const r = spawnSync(process.execPath, [bin, 'red-green', '--base', 'HEAD~1', '--head', 'HEAD', '--out', out],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(rep.verdict, 'valid_red');
    assert.equal(rep.base, base);
    assert.equal(rep.head, head);
    assert.match(r.stderr, /valid_red/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI red-green: head_fail exits 1 and prints JSON to stdout without --out', () => {
  const dir = makeRepo();
  try {
    commit(dir, { 'trust.config.json': nodeTestConfig(), 'src/add.mjs': 'export const add = (a, b) => a - b;\n' });
    commit(dir, { 'test/add.test.mjs': ADD_TEST });
    const r = spawnSync(process.execPath, [bin, 'red-green', '--base', 'HEAD~1', '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(JSON.parse(r.stdout).verdict, 'head_fail');
    assert.match(r.stderr, /head_fail/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI red-green: missing --base is a tool error (exit 1)', () => {
  const r = spawnSync(process.execPath, [bin, 'red-green', '--head', 'HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--base/);
});
