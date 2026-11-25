import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, writeFiles, nodeTestConfig, git } from './redgreen/helpers.mjs';
import { buildEvidence } from '../src/evidence.mjs';
import { loadItem } from '../src/items.mjs';
import { collectScreens } from '../src/screens.mjs';
import { SLUG, RUN_ID, RUN_URL, mkRun, mkJobs, fakeGithub, fakeGhEnv } from './fake-gh.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');

const TEST = { runnerId: 'unit', file: 'test/login.test.mjs', testName: 'rejects a bad password' };
const item = (surfaces, id = 'fix-login', extra = {}) => JSON.stringify({
  id, title: 'Fix login', surfaces, acceptance: ['login works'], approvals: [{ kind: 'hosting', target: 'web' }],
  tests: [TEST], ...extra,
});
/** Repo with config + items and an `origin` on GitHub; returns { dir, sha }. */
function setup() {
  const dir = makeRepo();
  const sha = commit(dir, {
    'trust.config.json': nodeTestConfig(),
    '.trust/items/fix-login.json': item(['app']),
    '.trust/items/backend.json': item(['functions'], 'backend'),
    '.trust/items/untested.json': item(['functions'], 'untested', { tests: undefined }),
  });
  git(dir, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
  return { dir, sha };
}

const row = (base, head, t = TEST) => ({ file: t.file, name: t.testName, base, head });
const report = (head, extra = {}) => ({
  schema: 'trust-kit/red-green@1', base: 'b'.repeat(40), requestedBase: 'b'.repeat(40), head,
  verdict: 'valid_red', runners: [{ id: 'unit', tests: [row('behavior_fail', 'pass')] }], newlyEnforced: [],
  generatedAt: '2026-11-25T00:00:00Z', ciRunUrl: RUN_URL, ...extra,
});
const run = mkRun;

/** buildEvidence options for a CI run serving `rep`. */
const ci = (sha, rep, runExtra = {}, jobs = undefined) => ({ runId: RUN_ID, github: fakeGithub({ run: run(sha, runExtra), rep, jobs }) });

function writeScreens(dir, sha) {
  const sd = path.join(dir, 'shots');
  writeFiles(dir, { 'shots/login.png': 'png-bytes' });
  collectScreens({ dir: sd, commit: sha });
  return sd;
}

test('report from a CI run of this repo and commit + item test red→green + screenshots → complete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, ...ci(sha, report(sha)), screensDir: writeScreens(dir, sha) });
  assert.equal(b.schema, 'trust-kit/evidence@2');
  assert.equal(b.complete, true, b.missing.join('\n'));
  assert.deepEqual(b.missing, []);
  assert.equal(b.commit, sha);
  assert.deepEqual(b.redGreen, { verdict: 'valid_red', ciRunUrl: RUN_URL, runId: RUN_ID, repo: SLUG, head: sha, base: 'b'.repeat(40) });
  assert.deepEqual(b.tests, [{ ...TEST, base: 'behavior_fail', head: 'pass', ok: true }]);
  assert.equal(b.screens.files.length, 1);
  assert.equal(b.item.id, 'fix-login');
  assert.ok(b.checks.every((c) => c.ok));
});

test('a run URL is accepted in place of the run id', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha)), runId: `${RUN_URL}/attempts/2` });
  assert.equal(b.complete, true, b.missing.join('\n'));
});

test('a run URL of another repository → incomplete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha)), runId: 'https://github.com/evil/fork/actions/runs/4242' });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((m) => m.includes('evil/fork')), b.missing.join('\n'));
});

test('short SHA input is resolved to the full commit', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha.slice(0, 8), ...ci(sha, report(sha)) });
  assert.equal(b.commit, sha);
  assert.equal(b.complete, true, b.missing.join('\n'));
});

test('unresolvable commit throws', async () => {
  const { dir, sha } = setup();
  await assert.rejects(buildEvidence({ repoRoot: dir, itemId: 'backend', commit: 'nothere', ...ci(sha, report(sha)) }));
});

test('the CI run is for another commit → incomplete with mismatch message', async () => {
  const { dir, sha } = setup();
  const other = 'c'.repeat(40);
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha), { head_sha: other }) });
  assert.equal(b.complete, false);
  const m = b.missing.find((s) => s.includes('CI run') && s.includes(other.slice(0, 12)));
  assert.ok(m && m.includes(sha.slice(0, 12)), b.missing.join('\n'));
});

test('the CI run belongs to another repository → incomplete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha), { repository: { full_name: 'evil/fork' } }) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('evil/fork')), b.missing.join('\n'));
});

test('the red-green job of the run did not succeed (e.g. ledger verify failed) → incomplete; other failing jobs do not matter', async () => {
  const { dir, sha } = setup();
  for (const jobs of [mkJobs('failure'), [mkJobs()[1]]]) {
    const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha), {}, jobs) });
    assert.equal(b.complete, false, JSON.stringify(jobs));
    assert.ok(b.missing.some((s) => s.includes('red-green')), b.missing.join('\n'));
  }
  const ok = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha)) });
  assert.equal(ok.complete, true, ok.missing.join('\n'));
});

test('the CI run has not completed, or is not a pull_request run → incomplete', async () => {
  const { dir, sha } = setup();
  for (const extra of [{ status: 'in_progress', conclusion: null }, { event: 'workflow_dispatch' }]) {
    const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha), extra) });
    assert.equal(b.complete, false, JSON.stringify(extra));
  }
});

test('the report head differs from the commit → incomplete with mismatch message', async () => {
  const { dir, sha } = setup();
  const other = 'c'.repeat(40);
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(other)) });
  assert.equal(b.complete, false);
  const m = b.missing.find((s) => s.includes('紅綠燈報告與目前 commit 不符'));
  assert.ok(m, b.missing.join('\n'));
  assert.ok(m.includes(other.slice(0, 12)) && m.includes(sha.slice(0, 12)));
});

test('a report whose ciRunUrl is not this run (or missing: produced locally) → incomplete', async () => {
  const { dir, sha } = setup();
  const local = report(sha); delete local.ciRunUrl;
  for (const rep of [report(sha, { ciRunUrl: 'https://github.com/acme/app/actions/runs/1' }), local]) {
    const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
    assert.equal(b.complete, false);
    assert.ok(b.missing.some((s) => s.includes('ciRunUrl')), b.missing.join('\n'));
  }
});

test('GitHub errors (gh missing, run not found, no artifact) are missing entries, not throws', async () => {
  const { dir, sha } = setup();
  const b1 = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, runId: RUN_ID, github: fakeGithub({ runError: 'HTTP 404' }) });
  assert.equal(b1.complete, false);
  assert.ok(b1.missing.some((s) => s.includes('HTTP 404')), b1.missing.join('\n'));
  const b2 = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, null) });
  assert.equal(b2.complete, false);
  assert.ok(b2.missing.some((s) => s.includes('trust-red-green')), b2.missing.join('\n'));
});

test('a repo whose origin is not on GitHub → incomplete', async () => {
  const { dir, sha } = setup();
  git(dir, 'remote', 'set-url', 'origin', 'https://gitlab.example/acme/app.git');
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('origin')), b.missing.join('\n'));
});

test('no_red → missing names the verdict and explains the test that should fail on base', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha, { verdict: 'no_red' })) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('no_red') && s.includes('在 base 上應失敗的測試')), b.missing.join('\n'));
});

test('I6: the PR is valid_red because of another item\'s test, but this item\'s own test did not go red→green → incomplete', async () => {
  const { dir, sha } = setup();
  const other = { runnerId: 'unit', file: 'test/other.test.mjs', testName: 'other item' };
  for (const mine of [row('pass', 'pass'), row('load_fail', 'pass')]) {
    const rep = report(sha, { runners: [{ id: 'unit', tests: [mine, row('behavior_fail', 'pass', other)] }] });
    const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
    assert.equal(b.complete, false, JSON.stringify(mine));
    assert.ok(b.missing.some((s) => s.includes(TEST.testName)), b.missing.join('\n'));
    assert.equal(b.tests[0].ok, false);
  }
});

test('I6: the item\'s named test is not in the report at all → incomplete', async () => {
  const { dir, sha } = setup();
  const rep = report(sha, { runners: [{ id: 'unit', tests: [row('behavior_fail', 'pass', { ...TEST, testName: 'something else' })] }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes(TEST.testName) && s.includes(TEST.file)), b.missing.join('\n'));
});

test('I6: an item that names no tests is never complete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'untested', commit: sha, ...ci(sha, report(sha)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('tests')), b.missing.join('\n'));
});

test('I6: a sibling test whose name merely ends with the same words does not prove the item', async () => {
  const { dir, sha } = setup();
  const rep = report(sha, { runners: [{ id: 'unit', tests: [
    row('pass', 'pass'),
    { file: TEST.file, name: `legacy path ${TEST.testName}`, base: 'behavior_fail', head: 'pass' },
  ] }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
  assert.equal(b.complete, false);
  assert.equal(b.tests[0].ok, false);
});

test('I6: a testName that matches more than one row is ambiguous → not ok', async () => {
  const { dir, sha } = setup();
  const rep = report(sha, { runners: [{ id: 'unit', tests: [
    { file: TEST.file, name: `a > ${TEST.testName}`, base: 'behavior_fail', head: 'pass' },
    { file: TEST.file, name: `b > ${TEST.testName}`, base: 'pass', head: 'pass' },
  ] }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('2')), b.missing.join('\n'));
});

test('the bundle records the report base and a repo-relative screens dir (packet re-verifies with them)', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, ...ci(sha, report(sha)), screensDir: writeScreens(dir, sha) });
  assert.equal(b.redGreen.base, 'b'.repeat(40));
  assert.equal(b.screensDir, 'shots');
});

test('I6: a nested test name matches its leaf testName', async () => {
  const { dir, sha } = setup();
  const rep = report(sha, { runners: [{ id: 'unit', tests: [{ file: TEST.file, name: `login > ${TEST.testName}`, base: 'behavior_fail', head: 'pass' }] }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
  assert.equal(b.complete, true, b.missing.join('\n'));
});

test('app item without screenshots → missing mentions screens', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, ...ci(sha, report(sha)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('screens')), b.missing.join('\n'));
});

test('screens collected for another commit → incomplete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, ...ci(sha, report(sha)), screensDir: writeScreens(dir, 'd'.repeat(40)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('screens')), b.missing.join('\n'));
});

test('functions item needs only red-green', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, report(sha)) });
  assert.equal(b.complete, true, b.missing.join('\n'));
  assert.equal(b.screens, undefined);
});

test('wrong schema or unparsable artifact is rejected as a missing entry, not a throw', async () => {
  const { dir, sha } = setup();
  for (const rep of [report(sha, { schema: 'other@1' }), '{not json']) {
    const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, rep) });
    assert.equal(b.complete, false);
    assert.ok(b.missing.length >= 1);
  }
});

test('ruleProblems in the report fail a check naming each rule id', async () => {
  const { dir, sha } = setup();
  const r = report(sha, { ruleProblems: [{ ruleId: 'R-12', problem: 'x' }, { ruleId: 'R-13', problem: 'y' }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, ...ci(sha, r) });
  assert.equal(b.complete, false);
  const c = b.checks.find((x) => !x.ok && x.detail.includes('R-12'));
  assert.ok(c && c.detail.includes('R-13'), JSON.stringify(b.checks));
});

test('loadItem rejects ids with path traversal', () => {
  const { dir } = setup();
  assert.throws(() => loadItem(dir, '../trust.config'));
  assert.throws(() => loadItem(dir, 'a/b'));
  assert.equal(loadItem(dir, 'fix-login').title, 'Fix login');
});

test('loadItem rejects invalid surfaces and approvals', () => {
  const { dir } = setup();
  writeFiles(dir, { '.trust/items/bad.json': JSON.stringify({ id: 'bad', title: 't', surfaces: ['tv'], acceptance: [], approvals: [] }) });
  assert.throws(() => loadItem(dir, 'bad'), /surfaces/);
  writeFiles(dir, { '.trust/items/bad2.json': JSON.stringify({ id: 'bad2', title: 't', surfaces: ['web'], acceptance: [], approvals: [{ kind: 'nuke', target: 'x' }] }) });
  assert.throws(() => loadItem(dir, 'bad2'), /approvals/);
});

test('loadItem: tests are optional but must be { runnerId, file, testName } when given', () => {
  const { dir } = setup();
  assert.deepEqual(loadItem(dir, 'backend').tests, [TEST]);
  assert.deepEqual(loadItem(dir, 'untested').tests, []);
  writeFiles(dir, { '.trust/items/bad3.json': item(['functions'], 'bad3', { tests: [{ runnerId: 'unit', file: 'x.test.mjs' }] }) });
  assert.throws(() => loadItem(dir, 'bad3'), /tests/);
});

const fakeGhBin = (dir, sha, rep) => fakeGhEnv(dir, { run: run(sha), rep });

test('CLI: evidence --run fetches the run and artifact through gh; exits 1 with missing lines; screens collect writes manifest', () => {
  const { dir, sha } = setup();
  const env = fakeGhBin(dir, sha, report(sha));
  const r1 = spawnSync(process.execPath, [bin, 'evidence', '--item', 'fix-login', '--run', RUN_ID], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(r1.stderr, /screens/);
  const out = path.join(dir, '.trust/evidence/fix-login.json');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).complete, false);

  writeFiles(dir, { 'shots/a.png': 'x' });
  const r2 = spawnSync(process.execPath, [bin, 'screens', 'collect', '--dir', 'shots', '--commit', sha.slice(0, 10)], { cwd: dir, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'shots/manifest.json'), 'utf8')).commit, sha);

  const r3 = spawnSync(process.execPath, [bin, 'evidence', '--item', 'fix-login', '--run', RUN_URL, '--screens', 'shots', '--out', 'ev.json'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r3.status, 0, r3.stderr);
  const ev = JSON.parse(fs.readFileSync(path.join(dir, 'ev.json'), 'utf8'));
  assert.equal(ev.complete, true);
  assert.equal(ev.redGreen.ciRunUrl, RUN_URL);
});

test('I5: CLI evidence no longer accepts a local --red-green file', () => {
  const { dir, sha } = setup();
  writeFiles(dir, { 'rg.json': JSON.stringify(report(sha)) });
  const r = spawnSync(process.execPath, [bin, 'evidence', '--item', 'backend', '--red-green', 'rg.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--run/);
  assert.equal(fs.existsSync(path.join(dir, '.trust/evidence/backend.json')), false);
});

test('I5: CLI red-green refuses --ci-run-url (a local report must never be stamped as CI)', () => {
  const { dir, sha } = setup();
  const r = spawnSync(process.execPath, [bin, 'red-green', '--base', sha, '--head', sha, '--ci-run-url', RUN_URL], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ci-run-url/);
});

// F1 regression: the screens manifest must be real, current evidence.
const shotsOf = (dir) => path.join(dir, 'shots');
const rewriteManifest = (dir, fn) => {
  const p = path.join(shotsOf(dir), 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8')))));
};
async function evidenceFor(dir, sha) {
  return buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, ...ci(sha, report(sha)), screensDir: shotsOf(dir) });
}

test('F1: manifest commit "HEAD" (a ref, not a full SHA) → incomplete', async () => {
  const { dir, sha } = setup();
  writeScreens(dir, sha);
  rewriteManifest(dir, (m) => ({ ...m, commit: 'HEAD' }));
  const b = await evidenceFor(dir, sha);
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('screens collect')), b.missing.join('\n'));
});

test('F1: manifest entry whose file was deleted → incomplete, names the file', async () => {
  const { dir, sha } = setup();
  writeScreens(dir, sha);
  fs.rmSync(path.join(shotsOf(dir), 'login.png'));
  const b = await evidenceFor(dir, sha);
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('login.png') && s.includes('screens collect')), b.missing.join('\n'));
});

test('F1: file bytes changed after collect → incomplete, names the file', async () => {
  const { dir, sha } = setup();
  writeScreens(dir, sha);
  fs.writeFileSync(path.join(shotsOf(dir), 'login.png'), 'tampered');
  const b = await evidenceFor(dir, sha);
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('login.png') && s.includes('screens collect')), b.missing.join('\n'));
});

test('F1: malformed manifest entries (traversal, absolute, bad sha256, non-object) → incomplete', async () => {
  for (const bad of [{ path: '../x.png', sha256: 'a'.repeat(64) }, { path: '/etc/x.png', sha256: 'a'.repeat(64) },
    { path: 'login.png', sha256: 'zz' }, 'junk', { sha256: 'a'.repeat(64) }]) {
    const { dir, sha } = setup();
    writeScreens(dir, sha);
    rewriteManifest(dir, (m) => ({ ...m, files: [...m.files, bad] }));
    const b = await evidenceFor(dir, sha);
    assert.equal(b.complete, false, JSON.stringify(bad));
    assert.ok(b.missing.some((s) => s.includes('screens collect')), b.missing.join('\n'));
  }
});

test('F1: a fresh valid collect is still complete', async () => {
  const { dir, sha } = setup();
  writeScreens(dir, sha);
  const b = await evidenceFor(dir, sha);
  assert.equal(b.complete, true, b.missing.join('\n'));
});
