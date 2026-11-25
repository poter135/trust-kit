import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getRunner, parseFlutterMachine } from '../../src/runners/index.mjs';
import { repoRoot, fixtures, readLines, brief } from './helpers.mjs';

const dir = path.join(fixtures, 'flutter');
const rel = (f) => `test/fixtures/runners/flutter/test/${f}`;
const EXPECTED = [
  { file: rel('behavior_test.dart'), name: 'assertion fails', status: 'behavior_fail' },
  { file: rel('behavior_test.dart'), name: 'throws at runtime', status: 'behavior_fail' },
  { file: rel('load_test.dart'), name: '(load)', status: 'load_fail' },
  { file: rel('pass_test.dart'), name: 'adds numbers', status: 'pass' },
];

test('parseFlutterMachine classifies recorded --machine output', () => {
  const results = parseFlutterMachine(readLines(path.join(dir, 'machine.jsonl')), '/REPO');
  // The recording also shows a real Flutter quirk: pass_test's "loading" test reports
  // "Dart compiler exited unexpectedly" (because load_test failed to compile) yet its test then runs and passes.
  // A loading error only means load_fail when the suite produced no test results.
  assert.deepEqual(brief(results), EXPECTED);
  const load = results.find((r) => r.status === 'load_fail');
  assert.match(load.message, /Compilation failed|can't be assigned/);
});

test('parseFlutterMachine: skipped tests map to skip, hidden passing tests are dropped', () => {
  const lines = [
    { type: 'suite', suite: { id: 0, path: '/r/test/a_test.dart' } },
    { type: 'testStart', test: { id: 1, name: 'loading /r/test/a_test.dart', suiteID: 0 } },
    { type: 'testDone', testID: 1, result: 'success', skipped: false, hidden: true },
    { type: 'testStart', test: { id: 2, name: 'later', suiteID: 0 } },
    { type: 'testDone', testID: 2, result: 'success', skipped: true, hidden: false },
  ].map((o) => JSON.stringify(o));
  assert.deepEqual(brief(parseFlutterMachine(lines, '/r')), [
    { file: 'test/a_test.dart', name: 'later', status: 'skip' },
  ]);
});

test('flutter runner runs real fixtures with repo-relative files', {
  skip: process.env.TRUST_KIT_FLUTTER ? false : 'set TRUST_KIT_FLUTTER=1 to run Flutter',
  timeout: 300_000,
}, async () => {
  const results = await getRunner('flutter').run({
    cwd: dir,
    repoRoot,
    files: ['pass_test.dart', 'behavior_test.dart', 'load_test.dart'].map(rel),
  });
  assert.deepEqual(brief(results), EXPECTED);
});
