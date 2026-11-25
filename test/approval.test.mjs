import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, nodeTestConfig } from './redgreen/helpers.mjs';
import { buildPacket, writePacket } from '../src/packet.mjs';
import { recordApproval, checkApproval } from '../src/approval.mjs';
import { mkItem, mkEvidence } from './packet-helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');
const HEAD = 'a'.repeat(40);
const OTHER = 'c'.repeat(40);

/** Repo with one packet: 1 = deploy-function fnA, 2 = hosting web, 3 = B2 flagged (no evidence). */
function setup() {
  const dir = makeRepo();
  commit(dir, { 'trust.config.json': nodeTestConfig() });
  const b1 = mkItem('B1', [{ kind: 'deploy-function', target: 'fnA' }, { kind: 'hosting', target: 'web' }]);
  const b2 = mkItem('B2', [{ kind: 'batch-write', target: 'catalog' }]);
  const p = buildPacket({ repoRoot: dir, head: HEAD, protectedChanges: [],
    items: [{ item: b1, evidence: mkEvidence(b1) }, { item: b2, evidence: null }] });
  writePacket({ repoRoot: dir, packet: p, head: HEAD, out: path.join(dir, 'review.md') });
  return { dir, p };
}

test('approved entry: same kind/target/commit → ok; different commit → reason has both commits', () => {
  const { dir, p } = setup();
  const rec = recordApproval({ repoRoot: dir, packetId: p.id, numbers: [1] });
  assert.equal(rec.approvedBy, 'user-chat');
  assert.ok(!Number.isNaN(Date.parse(rec.approvedAt)));
  assert.ok(fs.existsSync(path.join(dir, '.trust/approvals', `${p.id}.json`)));
  assert.deepEqual(checkApproval({ repoRoot: dir, kind: 'deploy-function', target: 'fnA', commit: HEAD }), { ok: true });
  const bad = checkApproval({ repoRoot: dir, kind: 'deploy-function', target: 'fnA', commit: OTHER });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes(HEAD) && bad.reason.includes(OTHER), bad.reason);
});

test('unapproved number → ok:false with 未核准', () => {
  const { dir, p } = setup();
  recordApproval({ repoRoot: dir, packetId: p.id, numbers: [1] });
  const r = checkApproval({ repoRoot: dir, kind: 'hosting', target: 'web', commit: HEAD });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('未核准'), r.reason);
});

test('no approvals dir at all → ok:false with 未核准', () => {
  const dir = makeRepo();
  const r = checkApproval({ repoRoot: dir, kind: 'hosting', target: 'web', commit: HEAD });
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('未核准'));
});

test('unknown packetId → throws and writes nothing', () => {
  const { dir } = setup();
  assert.throws(() => recordApproval({ repoRoot: dir, packetId: 'deadbeef0000', numbers: [1] }));
  assert.equal(fs.existsSync(path.join(dir, '.trust/approvals')), false);
});

test('flagged entry needs allowFlagged; null-kind and unknown numbers are refused', () => {
  const { dir, p } = setup();
  assert.throws(() => recordApproval({ repoRoot: dir, packetId: p.id, numbers: [3] }), /flagged|需要注意|--allow-flagged/);
  assert.throws(() => recordApproval({ repoRoot: dir, packetId: p.id, numbers: [9] }));
  assert.equal(fs.existsSync(path.join(dir, '.trust/approvals')), false);
  recordApproval({ repoRoot: dir, packetId: p.id, numbers: [3], allowFlagged: true });
  assert.deepEqual(checkApproval({ repoRoot: dir, kind: 'batch-write', target: 'catalog', commit: HEAD }), { ok: true });
});

test('second approval on the same packet keeps earlier entries', () => {
  const { dir, p } = setup();
  recordApproval({ repoRoot: dir, packetId: p.id, numbers: [1] });
  recordApproval({ repoRoot: dir, packetId: p.id, numbers: [2] });
  assert.equal(checkApproval({ repoRoot: dir, kind: 'deploy-function', target: 'fnA', commit: HEAD }).ok, true);
  assert.equal(checkApproval({ repoRoot: dir, kind: 'hosting', target: 'web', commit: HEAD }).ok, true);
});

test('CLI approve + check-approval: exit 0 on match, 1 on drift', () => {
  const { dir, p } = setup();
  const run = (...a) => spawnSync(process.execPath, [bin, ...a], { cwd: dir, encoding: 'utf8' });
  const ap = run('approve', '--packet', p.id, '--numbers', '1');
  assert.equal(ap.status, 0, ap.stderr);
  const ok = run('check-approval', '--kind', 'deploy-function', '--target', 'fnA', '--commit', HEAD);
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run('check-approval', '--kind', 'deploy-function', '--target', 'fnA', '--commit', OTHER);
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.includes(OTHER));
});
