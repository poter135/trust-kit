import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRules, verifyRules, rulesReport, newlyEnforcedIds, ruleEvidenceProblems, RulesError } from '../src/rules.mjs';
import { runRedGreen } from '../src/redgreen/run.mjs';
import { makeRepo, commit, nodeTestConfig } from './redgreen/helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');
const FIX = '補上檢查或把 status 改回 prose';

/** Temp dir with the given files. */
function tree(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-rules-')));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const rulesJson = (rules) => JSON.stringify({ version: 1, rules }, null, 2);
const RULE = { id: 'no-delete', source: 'docs/rules.md#no-delete', summary: 'never delete creator data', layer: 'machine', status: 'enforced',
  check: { runnerId: 'unit', file: 'test/no-delete.test.mjs', testName: 'refuses delete' } };
const GOOD_FILES = {
  'docs/rules.md': '## no-delete\nNever delete. 〔機器化：no-delete〕\n',
  'test/no-delete.test.mjs': "test('refuses delete', () => {});\n",
};

test('loadRules: missing file → empty registry; valid file parsed', () => {
  const empty = tree({});
  const full = tree({ '.trust/rules.json': rulesJson([RULE]) });
  try {
    assert.deepEqual(loadRules(empty), { version: 1, rules: [] });
    assert.deepEqual(loadRules(full).rules, [RULE]);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(full, { recursive: true, force: true });
  }
});

test('loadRules: invalid layer / status / duplicate id throw RulesError naming the field', () => {
  for (const [bad, re] of [
    [[{ ...RULE, layer: 'magic' }], /rules\[0\]\.layer/],
    [[{ ...RULE, status: 'done' }], /rules\[0\]\.status/],
    [[RULE, RULE], /duplicate id "no-delete"/],
  ]) {
    const dir = tree({ '.trust/rules.json': rulesJson(bad) });
    try {
      assert.throws(() => loadRules(dir), (e) => e instanceof RulesError && re.test(e.message));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('verifyRules: all good → ok', () => {
  const dir = tree({ ...GOOD_FILES, '.trust/rules.json': rulesJson([RULE, { id: 'p', source: 'docs/rules.md#p', summary: 's', layer: 'prose', status: 'prose' }]) });
  try {
    assert.deepEqual(verifyRules({ repoRoot: dir }), { ok: true, problems: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRules: enforced rule without check → ok:false, problem names the rule', () => {
  const { check, ...noCheck } = RULE;
  const dir = tree({ ...GOOD_FILES, '.trust/rules.json': rulesJson([noCheck]) });
  try {
    const r = verifyRules({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0].ruleId, 'no-delete');
    assert.match(r.problems[0].problem, /no-delete/);
    assert.match(r.problems[0].problem, /check/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRules: check.file missing → problem names the file, fix says 補上檢查或把 status 改回 prose', () => {
  const dir = tree({ 'docs/rules.md': GOOD_FILES['docs/rules.md'], '.trust/rules.json': rulesJson([RULE]) });
  try {
    const r = verifyRules({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].problem, /test\/no-delete\.test\.mjs/);
    assert.match(r.problems[0].fix, new RegExp(FIX));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRules: check.file lacks testName → problem names the test name', () => {
  const dir = tree({ ...GOOD_FILES, 'test/no-delete.test.mjs': "test('other', () => {});\n", '.trust/rules.json': rulesJson([RULE]) });
  try {
    const r = verifyRules({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].problem, /refuses delete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRules: source lacks marker → problem contains the full marker to add', () => {
  const dir = tree({ ...GOOD_FILES, 'docs/rules.md': '## no-delete\nNever delete.\n', '.trust/rules.json': rulesJson([RULE]) });
  try {
    const r = verifyRules({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.ok(r.problems[0].problem.includes('〔機器化：no-delete〕') || r.problems[0].fix.includes('〔機器化：no-delete〕'));
    assert.ok(r.problems[0].fix.includes('〔機器化：no-delete〕'));
    assert.match(r.problems[0].problem, /docs\/rules\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyRules: source file missing → problem', () => {
  const dir = tree({ 'test/no-delete.test.mjs': GOOD_FILES['test/no-delete.test.mjs'], '.trust/rules.json': rulesJson([RULE]) });
  try {
    const r = verifyRules({ repoRoot: dir });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].problem, /docs\/rules\.md/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rulesReport: markdown table with id, summary, layer, status, check', () => {
  const dir = tree({ '.trust/rules.json': rulesJson([RULE, { id: 'p', source: 'a.md#p', summary: 'pipe | here', layer: 'prose', status: 'prose' }]) });
  try {
    const md = rulesReport({ repoRoot: dir });
    const lines = md.trim().split('\n');
    assert.match(lines[0], /^\|.*id.*\|/);
    assert.match(lines[1], /^\|[-| ]+\|$/);
    assert.ok(lines.some((l) => l.includes('no-delete') && l.includes('never delete creator data') && l.includes('machine')
      && l.includes('enforced') && l.includes('test/no-delete.test.mjs') && l.includes('refuses delete')));
    assert.ok(lines.some((l) => l.includes('pipe \\| here')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('newlyEnforcedIds: enforced on head but not on base', () => {
  const base = { version: 1, rules: [{ ...RULE, status: 'prose' }, { ...RULE, id: 'old' }] };
  const head = { version: 1, rules: [RULE, { ...RULE, id: 'old' }, { ...RULE, id: 'fresh' }, { ...RULE, id: 'still-prose', status: 'prose' }] };
  assert.deepEqual(newlyEnforcedIds(base, head), ['no-delete', 'fresh']);
});

test('CLI rules verify: exit 1 with problem and fix; exit 0 when ok; rules report prints table', () => {
  const bad = tree({ 'docs/rules.md': GOOD_FILES['docs/rules.md'], '.trust/rules.json': rulesJson([RULE]) });
  const good = tree({ ...GOOD_FILES, '.trust/rules.json': rulesJson([RULE]) });
  try {
    let r = spawnSync(process.execPath, [bin, 'rules', 'verify', '--root', bad], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout + r.stderr, /no-delete/);
    assert.match(r.stdout + r.stderr, new RegExp(FIX));
    r = spawnSync(process.execPath, [bin, 'rules', 'verify', '--root', good], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [bin, 'rules', 'verify'], { encoding: 'utf8', cwd: good });
    assert.equal(r.status, 0, r.stderr);
    r = spawnSync(process.execPath, [bin, 'rules', 'report', '--root', good], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\| no-delete \|/);
    r = spawnSync(process.execPath, [bin, 'rules', 'nope'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
  } finally {
    fs.rmSync(bad, { recursive: true, force: true });
    fs.rmSync(good, { recursive: true, force: true });
  }
});

// --- red-green linkage ---

const NO_DELETE_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "import { remove } from '../src/store.mjs';\ntest('refuses delete', () => { assert.throws(() => remove()); });\n";
const PROSE_RULE = { ...RULE, status: 'prose', layer: 'prose' };
delete PROSE_RULE.check;

/** base: rule is prose, remove() silently deletes. head: rule enforced with a check test; `headStore` decides behavior. */
function enforceRepo({ baseStore, headStore }) {
  const dir = makeRepo();
  const base = commit(dir, {
    'trust.config.json': nodeTestConfig(), 'src/store.mjs': baseStore,
    'docs/rules.md': '## no-delete\nNever delete.\n', '.trust/rules.json': rulesJson([PROSE_RULE]),
  });
  const head = commit(dir, {
    'src/store.mjs': headStore, 'test/no-delete.test.mjs': NO_DELETE_TEST,
    'docs/rules.md': '## no-delete\nNever delete. 〔機器化：no-delete〕\n', '.trust/rules.json': rulesJson([RULE]),
  });
  return { dir, base, head };
}
const DELETES = 'export const remove = () => true;\n';
const REFUSES = "export const remove = () => { throw new Error('refused'); };\n";

test('red-green: newly enforced rule whose check fails on base by behavior → newlyEnforced lists it, valid_red', async () => {
  const { dir, base, head } = enforceRepo({ baseStore: DELETES, headStore: REFUSES });
  try {
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.deepEqual(rep.newlyEnforced, ['no-delete']);
    assert.equal(rep.verdict, 'valid_red', JSON.stringify(rep, null, 2));
    assert.equal(rep.ruleProblems, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('red-green: newly enforced rule whose check already passes on base → invalid_red naming the rule', async () => {
  const { dir, base, head } = enforceRepo({ baseStore: REFUSES, headStore: REFUSES });
  try {
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.deepEqual(rep.newlyEnforced, ['no-delete']);
    assert.equal(rep.verdict, 'invalid_red', JSON.stringify(rep, null, 2));
    assert.equal(rep.ruleProblems.length, 1);
    assert.equal(rep.ruleProblems[0].ruleId, 'no-delete');
    assert.match(rep.ruleProblems[0].problem, /no-delete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('red-green: newly enforced rule whose check file is not among changed tests → invalid_red even if other tests are valid_red', async () => {
  const dir = makeRepo();
  try {
    const base = commit(dir, {
      'trust.config.json': nodeTestConfig(), 'src/store.mjs': REFUSES, 'test/no-delete.test.mjs': NO_DELETE_TEST,
      'src/add.mjs': 'export const add = (a, b) => a - b;\n',
      'docs/rules.md': '## no-delete\n', '.trust/rules.json': rulesJson([PROSE_RULE]),
    });
    const head = commit(dir, {
      'src/add.mjs': 'export const add = (a, b) => a + b;\n',
      'test/add.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n"
        + "import { add } from '../src/add.mjs';\ntest('add', () => { assert.equal(add(1, 2), 3); });\n",
      'docs/rules.md': '## no-delete 〔機器化：no-delete〕\n', '.trust/rules.json': rulesJson([RULE]),
    });
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.deepEqual(rep.newlyEnforced, ['no-delete']);
    assert.equal(rep.verdict, 'invalid_red', JSON.stringify(rep, null, 2));
    assert.match(rep.ruleProblems[0].problem, /test\/no-delete\.test\.mjs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('red-green: no rules file on either side → newlyEnforced is []', async () => {
  const dir = makeRepo();
  try {
    const base = commit(dir, { 'trust.config.json': nodeTestConfig(), 'src/store.mjs': DELETES });
    const head = commit(dir, { 'src/store.mjs': REFUSES, 'test/no-delete.test.mjs': NO_DELETE_TEST });
    const rep = await runRedGreen({ repoRoot: dir, base, head });
    assert.deepEqual(rep.newlyEnforced, []);
    assert.equal(rep.verdict, 'valid_red');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ruleEvidenceProblems: the red→green row must be the rule\'s own check.testName, not another test in the same file', () => {
  const head = { version: 1, rules: [RULE] };
  const file = RULE.check.file;
  const other = [{ id: 'unit', tests: [
    { file, name: 'some other test', base: 'behavior_fail', head: 'pass' },
    { file, name: 'refuses delete', base: 'pass', head: 'pass' },
  ] }];
  const problems = ruleEvidenceProblems({ ids: ['no-delete'], head, runners: other });
  assert.equal(problems.length, 1, 'another test going red→green must not prove the rule');
  assert.match(problems[0].problem, /refuses delete/);

  for (const name of ['refuses delete', 'suite > refuses delete', 'describe block > refuses delete']) {
    const own = [{ id: 'unit', tests: [{ file, name, base: 'behavior_fail', head: 'pass' }] }];
    assert.deepEqual(ruleEvidenceProblems({ ids: ['no-delete'], head, runners: own }), [], name);
  }
});

test('ruleEvidenceProblems: a sibling whose name only ends with the same words does not prove the rule', () => {
  const head = { version: 1, rules: [RULE] };
  const file = RULE.check.file;
  const runners = [{ id: 'unit', tests: [{ file, name: 'never refuses delete', base: 'behavior_fail', head: 'pass' }] }];
  assert.equal(ruleEvidenceProblems({ ids: ['no-delete'], head, runners }).length, 1);
});
