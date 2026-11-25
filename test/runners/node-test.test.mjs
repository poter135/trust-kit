import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getRunner, parseNodeTestEvents } from '../../src/runners/index.mjs';
import { repoRoot, fixtures, readLines, brief } from './helpers.mjs';

const dir = path.join(fixtures, 'node-test');
const rel = (f) => `test/fixtures/runners/node-test/${f}`;
const EXPECTED = [
  { file: rel('behavior.fx.mjs'), name: 'assertion fails', status: 'behavior_fail' },
  { file: rel('behavior.fx.mjs'), name: 'throws at runtime', status: 'behavior_fail' },
  { file: rel('load.fx.mjs'), name: '(load)', status: 'load_fail' },
  { file: rel('pass.fx.mjs'), name: 'adds numbers', status: 'pass' },
];

test('parseNodeTestEvents classifies recorded reporter output', () => {
  const results = parseNodeTestEvents(readLines(path.join(dir, 'events.jsonl')), '/REPO');
  assert.deepEqual(brief(results), EXPECTED);
  const load = results.find((r) => r.status === 'load_fail');
  assert.match(load.message, /ERR_MODULE_NOT_FOUND|Cannot find module/);
});

test('parseNodeTestEvents: file-level failure after child results is still load_fail, never behavior_fail', () => {
  const lines = [
    JSON.stringify({ type: 'pass', file: '/r/a.mjs', name: 'ok', isFile: false, nesting: 0 }),
    JSON.stringify({ type: 'fail', file: '/r/a.mjs', name: 'a.mjs', isFile: true, nesting: 0, failureType: 'testCodeFailure', message: 'exit 1' }),
  ];
  assert.deepEqual(brief(parseNodeTestEvents(lines, '/r')), [
    { file: 'a.mjs', name: '(file)', status: 'load_fail' },
    { file: 'a.mjs', name: 'ok', status: 'pass' },
  ]);
});

test('parseNodeTestEvents: suites and subtestsFailed parents are not double counted; skip/todo map to skip', () => {
  const ev = (o) => JSON.stringify({ file: '/r/a.mjs', isFile: false, nesting: 1, ...o });
  const lines = [
    ev({ type: 'fail', name: 'inner', failureType: 'testCodeFailure', message: 'x' }),
    ev({ type: 'pass', name: 'skipped', skip: true }),
    ev({ type: 'pass', name: 'later', todo: true }),
    ev({ type: 'fail', name: 'group', nesting: 0, suite: true, failureType: 'subtestsFailed' }),
    'not json',
    '',
  ];
  assert.deepEqual(brief(parseNodeTestEvents(lines, '/r')), [
    { file: 'a.mjs', name: 'group > inner', status: 'behavior_fail' },
    { file: 'a.mjs', name: 'group > later', status: 'skip' },
    { file: 'a.mjs', name: 'group > skipped', status: 'skip' },
  ]);
});

test('node-test runner runs real fixtures with repo-relative files', async () => {
  const results = await getRunner('node-test').run({
    cwd: dir,
    repoRoot,
    files: ['pass.fx.mjs', 'behavior.fx.mjs', 'load.fx.mjs'].map(rel),
  });
  assert.deepEqual(brief(results), EXPECTED);
});

test('node-test runner: process failure with no events marks every file load_fail', async () => {
  const results = await getRunner('node-test').run({
    cwd: dir,
    repoRoot,
    files: [rel('pass.fx.mjs')],
    command: [process.execPath, '-e', 'process.exit(3)', '--'],
  });
  assert.deepEqual(brief(results), [{ file: rel('pass.fx.mjs'), name: '(load)', status: 'load_fail' }]);
});

test('node-test runner: module-load failure after tests registered is load_fail with the error text', async () => {
  const results = await getRunner('node-test').run({ cwd: dir, repoRoot, files: [rel('late-load.fx.mjs')] });
  assert.deepEqual(brief(results), [
    { file: rel('late-load.fx.mjs'), name: '(file)', status: 'load_fail' },
    { file: rel('late-load.fx.mjs'), name: 'registered before the failing import', status: 'pass' },
  ]);
  const file = results.find((r) => r.name === '(file)');
  assert.match(file.message, /ERR_MODULE_NOT_FOUND|Cannot find module/);
  assert.ok(!results.some((r) => r.status === 'behavior_fail'), 'must never look like a valid red');
});

test('parseNodeTestEvents: module-not-found thrown inside a test body is load_fail, not behavior_fail', () => {
  const ev = (name, message) => JSON.stringify({ type: 'fail', file: '/r/a.mjs', name, isFile: false, nesting: 0, failureType: 'testCodeFailure', message });
  const lines = [
    ev('esm', "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/r/checker.mjs' imported from /r/a.mjs"),
    ev('cjs', "Error: Cannot find module './checker.cjs'\nRequire stack:\n- /r/a.mjs"),
    ev('pkg', "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'left-pad' imported from /r/a.mjs"),
    ev('real', 'AssertionError: Expected values to be strictly equal:\n1 !== 2'),
  ];
  assert.deepEqual(brief(parseNodeTestEvents(lines, '/r')), [
    { file: 'a.mjs', name: 'cjs', status: 'load_fail' },
    { file: 'a.mjs', name: 'esm', status: 'load_fail' },
    { file: 'a.mjs', name: 'pkg', status: 'load_fail' },
    { file: 'a.mjs', name: 'real', status: 'behavior_fail' },
  ]);
});

test('node-test runner: import/require of a missing module inside a test body is load_fail', async () => {
  const results = await getRunner('node-test').run({ cwd: dir, repoRoot, files: [rel('missing-in-body.fx.mjs')] });
  assert.deepEqual(brief(results), [
    { file: rel('missing-in-body.fx.mjs'), name: 'imports a module that does not exist yet', status: 'load_fail' },
    { file: rel('missing-in-body.fx.mjs'), name: 'requires a module that does not exist yet', status: 'load_fail' },
  ]);
});
