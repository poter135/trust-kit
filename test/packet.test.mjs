import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, nodeTestConfig } from './redgreen/helpers.mjs';
import { buildPacket } from '../src/packet.mjs';
import { mkItem, mkEvidence, HEAD, BASE } from './packet-helpers.mjs';
import { git } from './redgreen/helpers.mjs';
import { SLUG, RUN_ID, RUN_URL, mkRun, fakeGhEnv } from './fake-gh.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');

function repo() {
  const dir = makeRepo();
  commit(dir, { 'trust.config.json': nodeTestConfig() });
  return dir;
}

const sections = (md) => md.split('\n').filter((l) => l.startsWith('## '));

test('protected changes: first ## section is 需要注意 and lists the path', () => {
  const dir = repo();
  const b1 = mkItem('B1');
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }], protectedChanges: ['trust.config.json'] });
  const first = sections(p.markdown)[0];
  assert.match(first, /^## 需要注意/);
  const body = p.markdown.split(first)[1].split('\n## ')[0];
  assert.ok(body.includes('trust.config.json'), body);
});

test('id is the first 12 hex of sha256(markdown); entries carry kind/target/commit', () => {
  const dir = repo();
  const b1 = mkItem('B1', [{ kind: 'deploy-function', target: 'fnA' }, { kind: 'hosting', target: 'web' }]);
  const b2 = mkItem('B2', []);
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }, { item: b2, evidence: mkEvidence(b2) }], protectedChanges: [] });
  assert.equal(p.id, createHash('sha256').update(p.markdown).digest('hex').slice(0, 12));
  assert.deepEqual(p.entries.map((e) => [e.n, e.item, e.kind, e.target, e.commit]), [
    [1, 'B1', 'deploy-function', 'fnA', HEAD], [2, 'B1', 'hosting', 'web', HEAD], [3, 'B2', null, null, HEAD]]);
  assert.deepEqual(p.entries[0].flagged, []);
  assert.ok(p.markdown.includes('Fix B1') && p.markdown.includes('valid_red') && p.markdown.includes('https://ci.example/runs/9'));
  assert.ok(p.markdown.includes(HEAD.slice(0, 12)));
});

test('incomplete, non-valid_red, missing and stale bundles are flagged with reasons', () => {
  const dir = repo();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((id) => mkItem(id));
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, protectedChanges: [], items: [
    { item: a, evidence: mkEvidence(a, HEAD, { complete: false, missing: ['缺截圖XYZ'] }) },
    { item: b, evidence: mkEvidence(b, HEAD, { redGreen: { verdict: 'no_red', ciRunUrl: null, head: HEAD } }) },
    { item: c, evidence: null },
    { item: d, evidence: mkEvidence(d, 'b'.repeat(40)) },
  ] });
  const [ea, eb, ec, ed] = p.entries;
  assert.ok(ea.flagged.some((f) => f.includes('缺截圖XYZ')), ea.flagged.join('|'));
  assert.ok(eb.flagged.some((f) => f.includes('no_red')), eb.flagged.join('|'));
  assert.ok(ec.flagged.some((f) => f.includes('沒有證據包') && f.includes('trust-kit evidence --item C')), ec.flagged.join('|'));
  assert.ok(ed.flagged.some((f) => f.includes('證據包是舊 commit 的')), ed.flagged.join('|'));
  const attention = p.markdown.split('## 需要注意')[1].split('\n## ')[0];
  for (const s of ['缺截圖XYZ', 'no_red', '沒有證據包', '證據包是舊 commit 的']) assert.ok(attention.includes(s), s);
});

/** main has config + item; `feature` branches off it with one more commit. Returns { dir, base, head }. */
function branchRepo() {
  const dir = makeRepo();
  const base = commit(dir, { 'trust.config.json': nodeTestConfig(), '.trust/items/B1.json': JSON.stringify(mkItem('B1')) });
  git(dir, 'switch', '-q', '-c', 'feature');
  const head = commit(dir, { 'src/x.js': '1' });
  fs.mkdirSync(path.join(dir, '.trust/evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify(mkEvidence(mkItem('B1'), head)));
  return { dir, base, head };
}

test('CLI packet writes markdown, <out>.json and .trust/packets/<id>.json', () => {
  const { dir, base, head } = ciRepo();
  const env = fakeGhEnv(dir, { run: mkRun(head), rep: ciReport(head, base, { file: B1_TEST.file, name: B1_TEST.testName, base: 'behavior_fail', head: 'pass' }) });
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify({ redGreen: { runId: RUN_ID } }));
  const out = path.join(dir, 'out', 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--base', base, '--out', out], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(out, 'utf8');
  const side = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
  assert.equal(side.id, createHash('sha256').update(md).digest('hex').slice(0, 12));
  assert.equal(side.head, head);
  assert.equal(side.entries[0].commit, head);
  assert.deepEqual(side.entries[0].flagged, []);
  assert.ok(side.generatedAt);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.trust/packets', `${side.id}.json`), 'utf8')), side);
  assert.ok(r.stdout.includes(side.id));
});

test('stage 1: batch-write entries are flagged as not approvable; others are not', () => {
  const dir = repo();
  const b1 = mkItem('B1', [{ kind: 'deploy-function', target: 'fnA' }, { kind: 'batch-write', target: 'catalog' }]);
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }], protectedChanges: [] });
  assert.deepEqual(p.entries[0].flagged, []);
  assert.ok(p.entries[1].flagged.includes('批次寫入計畫 hash 尚未支援（第二階段），不可核准'), p.entries[1].flagged.join('|'));
  assert.ok(p.markdown.split('## 需要注意')[1].split('\n## ')[0].includes('批次寫入計畫 hash 尚未支援'));
});

test('the packet records its base: shown in the markdown and part of the packet id', () => {
  const dir = repo();
  const b1 = mkItem('B1');
  const items = [{ item: b1, evidence: mkEvidence(b1) }];
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items, protectedChanges: [] });
  assert.ok(p.markdown.includes(`base：\`${BASE.slice(0, 12)}\``) && p.markdown.includes(BASE), p.markdown);
  const other = buildPacket({ repoRoot: dir, base: 'f'.repeat(40), head: HEAD, items, protectedChanges: [] });
  assert.notEqual(other.id, p.id);
});

test('base equal to head hides every change: every entry is flagged', () => {
  const dir = repo();
  const b1 = mkItem('B1');
  const p = buildPacket({ repoRoot: dir, base: HEAD, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }], protectedChanges: [] });
  assert.ok(p.entries[0].flagged.some((f) => f.includes('base 與 head 相同')), p.entries[0].flagged.join('|'));
});

test('CLI packet: base defaults to the merge-base with the default branch and is recorded', () => {
  const { dir, base, head } = branchRepo();
  const out = path.join(dir, 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const side = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
  assert.equal(side.base, base);
  assert.equal(side.head, head);
  assert.ok(fs.readFileSync(out, 'utf8').includes(base));
});

test('CLI packet: a --base that is not the merge-base with the default branch is refused (e.g. --base HEAD)', () => {
  const { dir } = branchRepo();
  const out = path.join(dir, 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--base', 'HEAD', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /merge-base/);
  assert.equal(fs.existsSync(out), false);
});

test('CLI packet: when origin/<default> exists it is the default branch, not the local branch', () => {
  const { dir, base } = branchRepo();
  // local main moves ahead of the fork point; origin/main stays at the fork point
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  git(dir, 'switch', '-q', 'main');
  commit(dir, { 'src/later.js': '2' });
  git(dir, 'switch', '-q', 'feature');
  const out = path.join(dir, 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--out', out], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(`${out}.json`, 'utf8')).base, base);
  assert.match(fs.readFileSync(out, 'utf8'), /origin\/main/);
});

const T1 = { runnerId: 'unit', file: 'test/b1.test.mjs', testName: 'b1 works' };
const ev2 = (item, extra = {}) => ({
  schema: 'trust-kit/evidence@2', item, commit: HEAD,
  redGreen: { verdict: 'valid_red', ciRunUrl: 'https://github.com/acme/app/actions/runs/9', runId: '9', repo: 'acme/app', head: HEAD },
  tests: item.tests.map((t) => ({ ...t, base: 'behavior_fail', head: 'pass', ok: true })),
  checks: [], complete: true, missing: [], ...extra,
});

test('I6: an item that names no tests is flagged even with a complete bundle', () => {
  const dir = repo();
  const b1 = { ...mkItem('B1'), tests: [] };
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: ev2(b1) }], protectedChanges: [] });
  assert.ok(p.entries[0].flagged.some((f) => f.includes('沒有列出證明它的測試')), p.entries[0].flagged.join('|'));
});

test('I6: a bundle from trust-kit before 0.4 (evidence@1, not fetched from a CI run) is flagged', () => {
  const dir = repo();
  const b1 = { ...mkItem('B1'), tests: [T1] };
  const old = { ...ev2(b1), schema: 'trust-kit/evidence@1' };
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: old }], protectedChanges: [] });
  assert.ok(p.entries[0].flagged.some((f) => f.includes('evidence@1')), p.entries[0].flagged.join('|'));
});

test('I6: the packet shows each item\'s acceptance and its own tests with their red→green result', () => {
  const dir = repo();
  const b1 = { ...mkItem('B1'), acceptance: ['登入失敗要顯示原因'], tests: [T1] };
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: ev2(b1) }], protectedChanges: [] });
  assert.deepEqual(p.entries[0].flagged, []);
  assert.ok(p.markdown.includes('登入失敗要顯示原因'), p.markdown);
  assert.ok(p.markdown.includes('test/b1.test.mjs') && p.markdown.includes('b1 works') && p.markdown.includes('behavior_fail → pass'), p.markdown);
});

test('the CI report was judged against another base than the packet base (stacked PR) → flagged', () => {
  const dir = repo();
  const b1 = mkItem('B1');
  const ev = mkEvidence(b1);
  ev.redGreen = { ...ev.redGreen, base: 'f'.repeat(40) };
  const p = buildPacket({ repoRoot: dir, base: BASE, head: HEAD, items: [{ item: b1, evidence: ev }], protectedChanges: [] });
  assert.ok(p.entries[0].flagged.some((f) => f.includes('紅綠燈的 base')), p.entries[0].flagged.join('|'));
});

/** branchRepo + origin on GitHub + an item with one test; returns { dir, base, head }. */
function ciRepo() {
  const { dir, base } = branchRepo();
  git(dir, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
  git(dir, 'update-ref', 'refs/remotes/origin/main', base);
  return { dir, base, head: git(dir, 'rev-parse', 'HEAD') };
}
const ciReport = (head, base, testRow) => ({ schema: 'trust-kit/red-green@1', base, requestedBase: base, head, verdict: 'valid_red',
  runners: [{ id: 'unit', tests: [testRow] }], newlyEnforced: [], generatedAt: '2026-11-26T00:00:00Z', ciRunUrl: RUN_URL });
const B1_TEST = mkItem('B1').tests[0];
const runPacket = (dir, env) => {
  const out = path.join(dir, 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--out', out], { cwd: dir, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
};

test('CLI packet re-verifies evidence from the CI run: a hand-written complete bundle without a run is flagged', () => {
  const { dir, head } = ciRepo();
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify({ schema: 'trust-kit/evidence@2', item: mkItem('B1'),
    commit: head, redGreen: { verdict: 'valid_red' }, tests: [], checks: [], complete: true, missing: [] }));
  const side = runPacket(dir, process.env);
  assert.ok(side.entries[0].flagged.some((f) => f.includes('CI run')), side.entries[0].flagged.join('|'));
});

test('CLI packet re-verifies evidence from the CI run: the file says complete but the run disagrees → flagged', () => {
  const { dir, base, head } = ciRepo();
  const env = fakeGhEnv(dir, { run: mkRun(head), rep: ciReport(head, base, { file: B1_TEST.file, name: B1_TEST.testName, base: 'pass', head: 'pass' }) });
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify({ ...mkEvidence(mkItem('B1'), head), redGreen: { runId: RUN_ID } }));
  const side = runPacket(dir, env);
  assert.ok(side.entries[0].flagged.some((f) => f.includes(B1_TEST.testName)), side.entries[0].flagged.join('|'));
});

test('CLI packet re-verifies evidence from the CI run: a real run proving the item\'s test → unflagged', () => {
  const { dir, base, head } = ciRepo();
  const env = fakeGhEnv(dir, { run: mkRun(head), rep: ciReport(head, base, { file: B1_TEST.file, name: B1_TEST.testName, base: 'behavior_fail', head: 'pass' }) });
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify({ redGreen: { runId: RUN_ID } }));
  const side = runPacket(dir, env);
  assert.deepEqual(side.entries[0].flagged, []);
});
