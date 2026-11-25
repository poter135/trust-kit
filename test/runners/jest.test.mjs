import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getRunner, parseJestJson } from '../../src/runners/index.mjs';
import { repoRoot, fixtures, brief } from './helpers.mjs';

const dir = path.join(fixtures, 'jest');
const rel = (f) => `test/fixtures/runners/jest/src/${f}`;
const EXPECTED = [
  { file: rel('behavior.spec.ts'), name: 'assertion fails', status: 'behavior_fail' },
  { file: rel('behavior.spec.ts'), name: 'throws at runtime', status: 'behavior_fail' },
  { file: rel('load.spec.ts'), name: '(load)', status: 'load_fail' },
  { file: rel('pass.spec.ts'), name: 'adds numbers', status: 'pass' },
];

test('parseJestJson classifies recorded output; ts-jest type error is load_fail', () => {
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'recorded.json'), 'utf8'));
  const results = parseJestJson(json, '/REPO');
  assert.deepEqual(brief(results), EXPECTED);
  const load = results.find((r) => r.status === 'load_fail');
  assert.match(load.message, /TS2322/);
  assert.doesNotMatch(load.message, /\u001b\[/, 'ANSI colour codes are stripped');
});

test('parseJestJson: nested names are ancestorTitles and title joined with " > " (same form as node:test)', () => {
  const json = { testResults: [{ name: '/r/a.spec.ts', status: 'passed', assertionResults: [
    { fullName: 'outer inner works', ancestorTitles: ['outer', 'inner'], title: 'works', status: 'passed', failureMessages: [] },
  ] }] };
  assert.deepEqual(brief(parseJestJson(json, '/r')), [{ file: 'a.spec.ts', name: 'outer > inner > works', status: 'pass' }]);
});

test('parseJestJson: a test that fails because a module cannot be found is load_fail, not behavior_fail', () => {
  const json = { testResults: [{
    name: '/r/a.spec.ts', status: 'failed', message: '',
    assertionResults: [
      { fullName: 'missing', status: 'failed', failureMessages: ["Cannot find module '../src/checker' from 'a.spec.ts'"] },
      { fullName: 'real', status: 'failed', failureMessages: ['expect(received).toBe(expected)\n\nExpected: 2\nReceived: 1'] },
    ],
  }] };
  assert.deepEqual(brief(parseJestJson(json, '/r')), [
    { file: 'a.spec.ts', name: 'missing', status: 'load_fail' },
    { file: 'a.spec.ts', name: 'real', status: 'behavior_fail' },
  ]);
});

test('parseJestJson: failed suite whose assertions all passed is load_fail (never behavior_fail), pending/todo map to skip', () => {
  const json = { testResults: [{
    name: '/r/a.spec.ts', status: 'failed', message: 'afterAll threw',
    assertionResults: [
      { fullName: 'ok', status: 'passed', failureMessages: [] },
      { fullName: 'later', status: 'todo', failureMessages: [] },
      { fullName: 'skipped', status: 'pending', failureMessages: [] },
    ],
  }] };
  assert.deepEqual(brief(parseJestJson(json, '/r')), [
    { file: 'a.spec.ts', name: '(file)', status: 'load_fail' },
    { file: 'a.spec.ts', name: 'later', status: 'skip' },
    { file: 'a.spec.ts', name: 'ok', status: 'pass' },
    { file: 'a.spec.ts', name: 'skipped', status: 'skip' },
  ]);
  assert.match(parseJestJson(json, '/r').find((r) => r.name === '(file)').message, /afterAll threw/);
});

const localJest = path.join(dir, 'node_modules', '.bin', 'jest');
const jestCommand = fs.existsSync(localJest) ? [localJest]
  : process.env.TRUST_KIT_JEST_BIN ? [process.env.TRUST_KIT_JEST_BIN] : null;

test('jest runner runs real fixtures with repo-relative files', {
  skip: jestCommand ? false : `no Jest: run "npm install" in ${path.relative(repoRoot, dir)} or set TRUST_KIT_JEST_BIN`,
}, async () => {
  const results = await getRunner('jest').run({
    cwd: dir,
    repoRoot,
    files: ['pass.spec.ts', 'behavior.spec.ts', 'load.spec.ts'].map(rel),
    command: jestCommand,
  });
  assert.deepEqual(brief(results), EXPECTED);
});

test('jest runner: process failure with no JSON marks every file load_fail', async () => {
  const results = await getRunner('jest').run({
    cwd: dir,
    repoRoot,
    files: [rel('pass.spec.ts')],
    command: [process.execPath, '-e', 'console.error("jest crashed"); process.exit(3)', '--'],
  });
  assert.deepEqual(brief(results), [{ file: rel('pass.spec.ts'), name: '(load)', status: 'load_fail' }]);
  assert.match(results[0].message, /jest crashed/);
});

test('jest runner: suite-level error after tests are defined is load_fail with the error text', {
  skip: jestCommand ? false : `no Jest: run "npm install" in ${path.relative(repoRoot, dir)} or set TRUST_KIT_JEST_BIN`,
}, async () => {
  const results = await getRunner('jest').run({ cwd: dir, repoRoot, files: [rel('late.spec.ts')], command: jestCommand });
  assert.deepEqual(brief(results), [
    { file: rel('late.spec.ts'), name: '(file)', status: 'load_fail' },
    { file: rel('late.spec.ts'), name: 'registered before the suite-level error', status: 'pass' },
  ]);
  assert.match(results.find((r) => r.name === '(file)').message, /suite-level boom after tests/);
  assert.ok(!results.some((r) => r.status === 'behavior_fail'), 'must never look like a valid red');
});
