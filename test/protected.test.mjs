import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeRepo, commit, git, nodeTestConfig } from './redgreen/helpers.mjs';
import { detectProtectedChanges } from '../src/protected.mjs';
import { loadConfig } from '../src/config.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');
const cfgText = nodeTestConfig(['test/**/*.test.mjs'], {});
const withProtected = (paths) => JSON.stringify({ ...JSON.parse(cfgText), protectedPaths: paths });

const rulesJson = (status, check = { runnerId: 'unit', file: 'test/rule_wa14.test.mjs', testName: 'wa14' }) => JSON.stringify({
  version: 1,
  rules: [{ id: 'wa14', source: 'docs/rules.md#wa14', summary: 's', layer: 'machine', status, ...(status === 'enforced' ? { check } : {}) }],
});

function setup(extraBase = {}) {
  const dir = makeRepo();
  const base = commit(dir, {
    'trust.config.json': withProtected(['.github/workflows/**']),
    'tools/trust-kit.version': '0.1.0\n',
    '.github/workflows/x.yml': 'a\n',
    'src/app.mjs': 'x\n',
    ...extraBase,
  });
  return { dir, base };
}

test('changed file matching a configured glob is reported', async () => {
  const { dir, base } = setup();
  const head = commit(dir, { '.github/workflows/x.yml': 'b\n', 'src/app.mjs': 'y\n' });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, ['.github/workflows/x.yml']);
});

test('tools/trust-kit.version is protected even when config omits it', async () => {
  const { dir, base } = setup();
  const head = commit(dir, { 'tools/trust-kit.version': '0.2.0\n' });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, ['tools/trust-kit.version']);
});

test('check file of a base-enforced rule is protected when modified', async () => {
  const { dir, base } = setup({ '.trust/rules.json': rulesJson('enforced'), 'test/rule_wa14.test.mjs': 'wa14\n' });
  const head = commit(dir, { 'test/rule_wa14.test.mjs': 'wa14 changed\n' });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, ['test/rule_wa14.test.mjs']);
});

test('check file of a base-enforced rule is protected when deleted, even if the rule is removed too', async () => {
  const { dir, base } = setup({ '.trust/rules.json': rulesJson('enforced'), 'test/rule_wa14.test.mjs': 'wa14\n' });
  const head = commit(dir, { 'test/rule_wa14.test.mjs': null, '.trust/rules.json': JSON.stringify({ version: 1, rules: [] }) });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, ['.trust/rules.json', 'test/rule_wa14.test.mjs']);
});

test('enforced → prose flags the rules file even if the passed config forgot it', async () => {
  const { dir, base } = setup({ '.trust/rules.json': rulesJson('enforced'), 'test/rule_wa14.test.mjs': 'wa14\n' });
  const head = commit(dir, { '.trust/rules.json': rulesJson('prose') });
  const config = { ...loadConfig(dir), protectedPaths: [] };
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config });
  assert.deepEqual(got, ['.trust/rules.json']);
});

test('renames report both old and new names; results are sorted and deduplicated', async () => {
  const { dir, base } = setup();
  git(dir, 'mv', '.github/workflows/x.yml', '.github/workflows/y.yml');
  const head = commit(dir, { 'tools/trust-kit.version': '0.3.0\n' });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, ['.github/workflows/x.yml', '.github/workflows/y.yml', 'tools/trust-kit.version']);
});

test('diffs from the merge-base: protected changes landed only on base are not reported', async () => {
  const { dir, base: root } = setup();
  git(dir, 'checkout', '-q', '-b', 'feature');
  const head = commit(dir, { 'src/app.mjs': 'feature\n' });
  git(dir, 'checkout', '-q', 'main');
  const base = commit(dir, { '.github/workflows/x.yml': 'moved on\n' });
  assert.notEqual(base, root);
  const got = await detectProtectedChanges({ repoRoot: dir, base, head, config: loadConfig(dir) });
  assert.deepEqual(got, []);
});

test('config defaults to the head commit trust.config.json', async () => {
  const { dir, base } = setup();
  const head = commit(dir, { '.github/workflows/x.yml': 'b\n' });
  const got = await detectProtectedChanges({ repoRoot: dir, base, head });
  assert.deepEqual(got, ['.github/workflows/x.yml']);
});

test('CLI `protected --base --head` prints one path per line and exits 0', () => {
  const { dir, base } = setup();
  const head = commit(dir, { '.github/workflows/x.yml': 'b\n', 'tools/trust-kit.version': '9\n' });
  const r = spawnSync(process.execPath, [bin, 'protected', '--base', base, '--head', head], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '.github/workflows/x.yml\ntools/trust-kit.version\n');
});
