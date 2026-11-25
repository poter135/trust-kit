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
  const { dir, base, head } = branchRepo();
  const out = path.join(dir, 'out', 'review.md');
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'B1', '--base', base, '--out', out], { cwd: dir, encoding: 'utf8' });
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
