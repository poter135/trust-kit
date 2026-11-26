// item-gate: a change touching product paths must add or modify a work item (or an exemption with a reason).
// Driven through the CLI so that, before the subcommand exists, each test fails by assertion (behavior_fail).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, commit, git, nodeTestConfig } from './redgreen/helpers.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');

const cfg = (itemGate) => JSON.stringify({ ...JSON.parse(nodeTestConfig()), ...(itemGate ? { itemGate } : {}) });
const ENFORCE = { productPaths: ['app/**', 'server/src/**'], mode: 'enforce' };
const WARN = { ...ENFORCE, mode: 'warn' };
const item = (id) => JSON.stringify({ id, title: `Change ${id}`, surfaces: ['web'], acceptance: ['works'], approvals: [] });
const exemption = (reason) => JSON.stringify({ reason });

/** Base commit with the given gate config; returns { dir, base }. */
function setup(itemGate = ENFORCE, extra = {}) {
  const dir = makeRepo();
  const base = commit(dir, { 'trust.config.json': cfg(itemGate), 'app/main.js': 'v1\n', 'docs/a.md': 'a\n', ...extra });
  return { dir, base };
}

/** Runs `item-gate` in dir; returns { status, stderr, report }. */
function gate(dir, base, head, env = {}) {
  const out = path.join(dir, '..', `${path.basename(dir)}-gate.json`);
  const r = spawnSync(process.execPath, [bin, 'item-gate', '--base', base, '--head', head, '--out', out],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', ...env } });
  let report = null;
  try { report = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { report = null; }
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, report };
}

test('item-gate: product change without an item fails when enforced', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.report?.verdict, 'missing');
  assert.deepEqual(r.report?.productChanges, ['app/main.js']);
  assert.match(r.stderr, /\.trust\/items/);
});

test('item-gate: product change with an added item passes', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n', '.trust/items/X1.json': item('X1') });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'item');
  assert.deepEqual(r.report?.items, ['X1']);
});

test('item-gate: modifying an existing item counts', () => {
  const { dir, base } = setup(ENFORCE, { '.trust/items/X1.json': item('X1') });
  const head = commit(dir, { 'app/main.js': 'v2\n', '.trust/items/X1.json': JSON.stringify({ ...JSON.parse(item('X1')), title: 'Changed' }) });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'item');
});

test('item-gate: an invalid or deleted item does not count', () => {
  const { dir, base } = setup(ENFORCE, { '.trust/items/X1.json': item('X1') });
  const head = commit(dir, { 'app/main.js': 'v2\n', '.trust/items/X1.json': null, '.trust/items/X2.json': '{"id":"wrong"}' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.report?.verdict, 'missing');
  assert.ok(r.report?.problems.some((p) => p.includes('.trust/items/X2.json')), JSON.stringify(r.report?.problems));
});

test('item-gate: exemption with a reason passes; reason is reported', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n', '.trust/exemptions/typo.json': exemption('只改註解錯字，沒有行為變化') });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'exempt');
  assert.deepEqual(r.report?.exemptions, [{ file: '.trust/exemptions/typo.json', reason: '只改註解錯字，沒有行為變化' }]);
});

test('item-gate: exemption without a real reason does not count', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n', '.trust/exemptions/a.json': exemption('  short  '), '.trust/exemptions/b.json': '{}' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.report?.verdict, 'missing');
  assert.equal(r.report?.problems.length, 2, JSON.stringify(r.report?.problems));
});

test('item-gate: exemption already on base does not cover a new change', () => {
  const { dir, base } = setup(ENFORCE, { '.trust/exemptions/old.json': exemption('以前的豁免理由，不能沿用') });
  const head = commit(dir, { 'app/main.js': 'v2\n' });
  assert.equal(gate(dir, base, head).status, 1);
});

test('item-gate: change outside product paths passes', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'docs/a.md': 'b\n', 'test/x.test.mjs': 't\n' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'no_product_change');
});

test('item-gate: warn mode reports missing but exits 0, with a GitHub warning annotation', () => {
  const { dir, base } = setup(WARN);
  const head = commit(dir, { 'app/main.js': 'v2\n' });
  const r = gate(dir, base, head, { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'missing');
  assert.equal(r.report?.mode, 'warn');
  assert.match(r.stdout, /^::warning::/m);
});

test('item-gate: enforce failure emits a GitHub error annotation', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n' });
  const r = gate(dir, base, head, { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error::/m);
});

test('item-gate: config is read from base, so a PR cannot switch itself to warn or remove the gate', () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'app/main.js': 'v2\n', 'trust.config.json': cfg({ ...ENFORCE, mode: 'warn' }) });
  assert.equal(gate(dir, base, head).status, 1);
  const head2 = commit(dir, { 'trust.config.json': cfg(null) });
  assert.equal(gate(dir, base, head2).status, 1);
});

test('item-gate: base without itemGate config is not_configured and exits 0', () => {
  const { dir, base } = setup(null);
  const head = commit(dir, { 'app/main.js': 'v2\n', 'trust.config.json': cfg(ENFORCE) });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'not_configured');
});

test('item-gate: diffs from the merge-base, so product changes landed only on base are ignored', () => {
  const { dir, base: root } = setup();
  git(dir, 'checkout', '-q', '-b', 'feature');
  const head = commit(dir, { 'docs/a.md': 'feature\n' });
  git(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { 'app/main.js': 'moved on\n' });
  assert.notEqual(base, root);
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'no_product_change');
});

test('item-gate: invalid itemGate config is a config error naming the field', () => {
  const { dir, base } = setup({ productPaths: [], mode: 'enforce' });
  const head = commit(dir, { 'app/main.js': 'v2\n' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /itemGate\.productPaths/);
  const { dir: d2, base: b2 } = setup({ productPaths: ['app/**'], mode: 'loud' });
  const r2 = gate(d2, b2, commit(d2, { 'app/main.js': 'v2\n' }));
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /itemGate\.mode/);
});

test('item-gate: ignorePaths excludes test files that live under product paths', () => {
  const { dir, base } = setup({ ...ENFORCE, ignorePaths: ['app/**/*.test.js'] });
  const head = commit(dir, { 'app/main.test.js': 't\n' });
  const r = gate(dir, base, head);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.report?.verdict, 'no_product_change');
  const head2 = commit(dir, { 'app/main.test.js': 't2\n', 'app/main.js': 'v2\n' });
  const r2 = gate(dir, base, head2);
  assert.equal(r2.status, 1);
  assert.deepEqual(r2.report?.productChanges, ['app/main.js']);
});
