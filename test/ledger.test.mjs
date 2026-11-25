import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, commit, git, nodeTestConfig } from './redgreen/helpers.mjs';
import { appendLedger, verifyLedger } from '../src/ledger.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');
const L = '.trust/ledger.jsonl';
const l1 = '{"kind":"claim","item":"a","commit":"c1"}\n';
const l2 = '{"kind":"review","item":"a","commit":"c2"}\n';
const l3 = '{"kind":"release","item":"a","commit":"c3"}\n';

function repoWithLedger() {
  const dir = makeRepo();
  const base = commit(dir, { [L]: l1 + l2, 'trust.config.json': JSON.stringify({ ...JSON.parse(nodeTestConfig()), ledger: { path: L } }) });
  return { dir, base };
}

test('appending a line after the base content is ok', async () => {
  const { dir, base } = repoWithLedger();
  commit(dir, { [L]: l1 + l2 + l3 });
  assert.deepEqual(await verifyLedger({ repoRoot: dir, path: L, base }), { ok: true });
});

test('editing line 1 is not ok and names line 1', async () => {
  const { dir, base } = repoWithLedger();
  commit(dir, { [L]: l1.replace('c1', 'cX') + l2 + l3 });
  const r = await verifyLedger({ repoRoot: dir, path: L, base });
  assert.equal(r.ok, false);
  assert.match(r.problem, /line 1\b/);
});

test('deleting line 2 is not ok', async () => {
  const { dir, base } = repoWithLedger();
  commit(dir, { [L]: l1 });
  const r = await verifyLedger({ repoRoot: dir, path: L, base });
  assert.equal(r.ok, false);
  assert.match(r.problem, /line 2\b/);
});

test('missing at base is ok; missing at head but present at base is not', async () => {
  const dir = makeRepo();
  const base = commit(dir, { 'x.txt': '1' });
  commit(dir, { [L]: l1 });
  assert.equal((await verifyLedger({ repoRoot: dir, path: L, base })).ok, true);
  const base2 = git(dir, 'rev-parse', 'HEAD');
  commit(dir, { [L]: null });
  const r = await verifyLedger({ repoRoot: dir, path: L, base: base2 });
  assert.equal(r.ok, false);
  assert.match(r.problem, /missing|deleted/);
});

test('verify uses the merge-base: ledger lines appended only on base do not count against head', async () => {
  const { dir } = repoWithLedger();
  git(dir, 'checkout', '-q', '-b', 'feature');
  commit(dir, { [L]: l1 + l2 + l3 });
  const headSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { [L]: l1 + l2 + '{"kind":"reopen","item":"b","commit":"c9"}\n' });
  git(dir, 'checkout', '-q', 'feature');
  assert.equal(headSha, git(dir, 'rev-parse', 'HEAD'));
  assert.deepEqual(await verifyLedger({ repoRoot: dir, path: L, base }), { ok: true });
});

test('appendLedger writes exactly one JSON line, fills `at`, creates parent dirs', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ledger-')));
  const p = path.join(dir, 'a', 'b', 'ledger.jsonl');
  appendLedger(p, { kind: 'claim', item: 'T1', commit: 'abc', note: 'x' });
  appendLedger(p, { kind: 'deviation', item: 'T1', commit: 'abd', at: '2026-01-01T00:00:00.000Z' });
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  const a = JSON.parse(lines[0]);
  assert.equal(a.kind, 'claim'); assert.equal(a.note, 'x');
  assert.ok(!Number.isNaN(Date.parse(a.at)));
  assert.equal(JSON.parse(lines[1]).at, '2026-01-01T00:00:00.000Z');
});

test('appendLedger rejects bad kind or empty item/commit without writing', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-ledger-')));
  const p = path.join(dir, 'ledger.jsonl');
  assert.throws(() => appendLedger(p, { kind: 'nope', item: 'a', commit: 'b' }), /kind/);
  assert.throws(() => appendLedger(p, { kind: 'claim', item: '', commit: 'b' }), /item/);
  assert.throws(() => appendLedger(p, { kind: 'claim', item: 'a', commit: 1 }), /commit/);
  assert.equal(fs.existsSync(p), false);
});

test('CLI `ledger verify --base` exits 1 naming the edited line, 0 on pure append', () => {
  const { dir, base } = repoWithLedger();
  commit(dir, { [L]: l1 + l2 + l3 });
  let r = spawnSync(process.execPath, [bin, 'ledger', 'verify', '--base', base], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  commit(dir, { [L]: l1 + 'tampered\n' + l3 });
  r = spawnSync(process.execPath, [bin, 'ledger', 'verify', '--base', base], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /line 2\b/);
});
