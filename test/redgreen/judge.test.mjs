import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeRedGreen, combineVerdicts } from '../../src/redgreen/judge.mjs';

const changed = [{ runnerId: 'unit', file: 'test/a.test.mjs' }];
const r = (name, status, file = 'test/a.test.mjs') => ({ file, name, status });

test('rule 1: no changed tests → no_tests', () => {
  const j = judgeRedGreen({ changed: [], baseResults: [], headResults: [] });
  assert.equal(j.verdict, 'no_tests');
  assert.deepEqual(j.tests, []);
});

test('rule 2: a changed test not pass/skip on head → head_fail (even with a base behavior_fail)', () => {
  const j = judgeRedGreen({ changed, baseResults: [r('x', 'behavior_fail')], headResults: [r('x', 'pass'), r('y', 'load_fail')] });
  assert.equal(j.verdict, 'head_fail');
});

test('rule 3: base behavior_fail, head pass → valid_red', () => {
  const j = judgeRedGreen({ changed, baseResults: [r('x', 'behavior_fail')], headResults: [r('x', 'pass'), r('s', 'skip')] });
  assert.equal(j.verdict, 'valid_red');
  assert.deepEqual(j.tests, [
    { file: 'test/a.test.mjs', name: 's', base: 'absent', head: 'skip' },
    { file: 'test/a.test.mjs', name: 'x', base: 'behavior_fail', head: 'pass' },
  ]);
});

test('rule 4: base only load_fail → invalid_red; base-only rows are kept with head absent', () => {
  const j = judgeRedGreen({ changed, baseResults: [r('(load)', 'load_fail')], headResults: [r('x', 'pass')] });
  assert.equal(j.verdict, 'invalid_red');
  assert.deepEqual(j.tests, [
    { file: 'test/a.test.mjs', name: '(load)', base: 'load_fail', head: 'absent' },
    { file: 'test/a.test.mjs', name: 'x', base: 'absent', head: 'pass' },
  ]);
});

test('rule 5: base passes → no_red', () => {
  const j = judgeRedGreen({ changed, baseResults: [r('x', 'pass')], headResults: [r('x', 'pass')] });
  assert.equal(j.verdict, 'no_red');
});

test('one behavior_fail and one load_fail in the same file → valid_red', () => {
  const j = judgeRedGreen({ changed,
    baseResults: [r('x', 'behavior_fail'), r('(file)', 'load_fail')], headResults: [r('x', 'pass')] });
  assert.equal(j.verdict, 'valid_red');
});

test('results for files that are not changed tests are ignored', () => {
  const j = judgeRedGreen({ changed,
    baseResults: [r('x', 'pass'), r('o', 'behavior_fail', 'test/other.test.mjs')],
    headResults: [r('x', 'pass'), r('o', 'load_fail', 'test/other.test.mjs')] });
  assert.equal(j.verdict, 'no_red');
  assert.equal(j.tests.length, 1);
});

test('combineVerdicts: head_fail > valid_red > invalid_red > no_red; no_tests only when all are', () => {
  assert.equal(combineVerdicts([]), 'no_tests');
  assert.equal(combineVerdicts(['no_tests', 'no_tests']), 'no_tests');
  assert.equal(combineVerdicts(['no_tests', 'no_red']), 'no_red');
  assert.equal(combineVerdicts(['no_red', 'invalid_red']), 'invalid_red');
  assert.equal(combineVerdicts(['invalid_red', 'valid_red']), 'valid_red');
  assert.equal(combineVerdicts(['valid_red', 'head_fail']), 'head_fail');
});
