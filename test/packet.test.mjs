import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, nodeTestConfig } from './redgreen/helpers.mjs';
import { buildPacket } from '../src/packet.mjs';
import { mkItem, mkEvidence, HEAD } from './packet-helpers.mjs';

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
  const p = buildPacket({ repoRoot: dir, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }], protectedChanges: ['trust.config.json'] });
  const first = sections(p.markdown)[0];
  assert.match(first, /^## 需要注意/);
  const body = p.markdown.split(first)[1].split('\n## ')[0];
  assert.ok(body.includes('trust.config.json'), body);
});

test('id is the first 12 hex of sha256(markdown); entries carry kind/target/commit', () => {
  const dir = repo();
  const b1 = mkItem('B1', [{ kind: 'deploy-function', target: 'fnA' }, { kind: 'hosting', target: 'web' }]);
  const b2 = mkItem('B2', []);
  const p = buildPacket({ repoRoot: dir, head: HEAD, items: [{ item: b1, evidence: mkEvidence(b1) }, { item: b2, evidence: mkEvidence(b2) }], protectedChanges: [] });
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
  const p = buildPacket({ repoRoot: dir, head: HEAD, protectedChanges: [], items: [
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

test('CLI packet writes markdown, <out>.json and .trust/packets/<id>.json', () => {
  const dir = makeRepo();
  const base = commit(dir, { 'trust.config.json': nodeTestConfig(), '.trust/items/B1.json': JSON.stringify(mkItem('B1')) });
  const head = commit(dir, { 'src/x.js': '1' });
  fs.mkdirSync(path.join(dir, '.trust/evidence'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.trust/evidence/B1.json'), JSON.stringify(mkEvidence(mkItem('B1'), head)));
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
