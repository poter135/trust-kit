import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, writeFiles, nodeTestConfig } from './redgreen/helpers.mjs';
import { buildEvidence } from '../src/evidence.mjs';
import { loadItem } from '../src/items.mjs';
import { collectScreens } from '../src/screens.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');

const item = (surfaces, id = 'fix-login') => JSON.stringify({
  id, title: 'Fix login', surfaces, acceptance: ['login works'], approvals: [{ kind: 'hosting', target: 'web' }],
});

/** Repo with config + items; returns { dir, sha }. */
function setup() {
  const dir = makeRepo();
  const sha = commit(dir, {
    'trust.config.json': nodeTestConfig(),
    '.trust/items/fix-login.json': item(['app']),
    '.trust/items/backend.json': item(['functions'], 'backend'),
  });
  return { dir, sha };
}

const report = (head, extra = {}) => ({
  schema: 'trust-kit/red-green@1', base: 'b'.repeat(40), requestedBase: 'b'.repeat(40), head,
  verdict: 'valid_red', runners: [], newlyEnforced: [], generatedAt: '2026-11-25T00:00:00Z',
  ciRunUrl: 'https://ci.example/runs/1', ...extra,
});

function writeReport(dir, r) {
  const p = path.join(dir, 'out', 'rg.json');
  writeFiles(dir, { 'out/rg.json': JSON.stringify(r) });
  return p;
}

function writeScreens(dir, sha) {
  const sd = path.join(dir, 'shots');
  writeFiles(dir, { 'shots/login.png': 'png-bytes' });
  collectScreens({ dir: sd, commit: sha });
  return sd;
}

test('valid red + same commit + screenshots on an app item → complete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, redGreenPath: writeReport(dir, report(sha)), screensDir: writeScreens(dir, sha) });
  assert.equal(b.schema, 'trust-kit/evidence@1');
  assert.equal(b.complete, true, b.missing.join('\n'));
  assert.deepEqual(b.missing, []);
  assert.equal(b.commit, sha);
  assert.deepEqual(b.redGreen, { verdict: 'valid_red', ciRunUrl: 'https://ci.example/runs/1', head: sha });
  assert.equal(b.screens.files.length, 1);
  assert.equal(b.item.id, 'fix-login');
  assert.ok(b.checks.every((c) => c.ok));
});

test('short SHA input is resolved to the full commit', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha.slice(0, 8), redGreenPath: writeReport(dir, report(sha)) });
  assert.equal(b.commit, sha);
  assert.equal(b.complete, true, b.missing.join('\n'));
});

test('unresolvable commit throws', async () => {
  const { dir, sha } = setup();
  await assert.rejects(buildEvidence({ repoRoot: dir, itemId: 'backend', commit: 'nothere', redGreenPath: writeReport(dir, report(sha)) }));
});

test('red-green head differs from commit → incomplete with mismatch message', async () => {
  const { dir, sha } = setup();
  const other = 'c'.repeat(40);
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, report(other)) });
  assert.equal(b.complete, false);
  const m = b.missing.find((s) => s.includes('紅綠燈報告與目前 commit 不符'));
  assert.ok(m, b.missing.join('\n'));
  assert.ok(m.includes(other.slice(0, 12)) && m.includes(sha.slice(0, 12)));
});

test('no_red → missing names the verdict and explains the test that should fail on base', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, report(sha, { verdict: 'no_red' })) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('no_red') && s.includes('在 base 上應失敗的測試')), b.missing.join('\n'));
});

test('app item without screenshots → missing mentions screens', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, redGreenPath: writeReport(dir, report(sha)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('screens')), b.missing.join('\n'));
});

test('screens collected for another commit → incomplete', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, redGreenPath: writeReport(dir, report(sha)), screensDir: writeScreens(dir, 'd'.repeat(40)) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('screens')), b.missing.join('\n'));
});

test('functions item needs only red-green', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, report(sha)) });
  assert.equal(b.complete, true, b.missing.join('\n'));
  assert.equal(b.screens, undefined);
});

test('missing ciRunUrl → incomplete', async () => {
  const { dir, sha } = setup();
  const r = report(sha); delete r.ciRunUrl;
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, r) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('ciRunUrl')), b.missing.join('\n'));
});

test('wrong schema red-green file is rejected as a missing entry, not a throw', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, report(sha, { schema: 'other@1' })) });
  assert.equal(b.complete, false);
  assert.ok(b.missing.some((s) => s.includes('trust-kit/red-green@1')), b.missing.join('\n'));
});

test('unreadable red-green file is a missing entry', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: path.join(dir, 'nope.json') });
  assert.equal(b.complete, false);
  assert.ok(b.missing.length >= 1);
});

test('ruleProblems in the report fail a check naming each rule id', async () => {
  const { dir, sha } = setup();
  const r = report(sha, { ruleProblems: [{ ruleId: 'R-12', problem: 'x' }, { ruleId: 'R-13', problem: 'y' }] });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'backend', commit: sha, redGreenPath: writeReport(dir, r) });
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

test('CLI: evidence exits 1 with missing lines and writes default out; screens collect writes manifest', () => {
  const { dir, sha } = setup();
  const rg = writeReport(dir, report(sha));
  const r1 = spawnSync(process.execPath, [bin, 'evidence', '--item', 'fix-login', '--red-green', rg], { cwd: dir, encoding: 'utf8' });
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(r1.stderr, /screens/);
  const out = path.join(dir, '.trust/evidence/fix-login.json');
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).complete, false);

  writeFiles(dir, { 'shots/a.png': 'x' });
  const r2 = spawnSync(process.execPath, [bin, 'screens', 'collect', '--dir', 'shots', '--commit', sha.slice(0, 10)], { cwd: dir, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'shots/manifest.json'), 'utf8')).commit, sha);

  const r3 = spawnSync(process.execPath, [bin, 'evidence', '--item', 'fix-login', '--red-green', rg, '--screens', 'shots', '--out', 'ev.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ev.json'), 'utf8')).complete, true);
});

// F1 regression: the screens manifest must be real, current evidence.
const shotsOf = (dir) => path.join(dir, 'shots');
const rewriteManifest = (dir, fn) => {
  const p = path.join(shotsOf(dir), 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(fn(JSON.parse(fs.readFileSync(p, 'utf8')))));
};
async function evidenceFor(dir, sha) {
  return buildEvidence({ repoRoot: dir, itemId: 'fix-login', commit: sha, redGreenPath: writeReport(dir, report(sha)), screensDir: shotsOf(dir) });
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
