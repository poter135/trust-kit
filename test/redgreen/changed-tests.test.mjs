import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listChangedTests } from '../../src/redgreen/changed-tests.mjs';
import { loadConfig } from '../../src/config.mjs';
import { makeRepo, commit, nodeTestConfig } from './helpers.mjs';

test('lists added and modified files matching a runner testGlobs; deletions and non-matches are excluded', async () => {
  const dir = makeRepo();
  try {
    const base = commit(dir, {
      'trust.config.json': nodeTestConfig(),
      'test/mod.test.mjs': '// v1\n', 'test/del.test.mjs': '//\n', 'test/old-name.test.mjs': '// same\n', 'src/a.mjs': '//\n',
    });
    const head = commit(dir, {
      'test/mod.test.mjs': '// v2\n', 'test/del.test.mjs': null, 'test/new.test.mjs': '//\n', 'src/a.mjs': '// changed\n',
      'test/old-name.test.mjs': null, 'test/renamed.test.mjs': '// same\n', 'test/helper.mjs': '//\n',
    });
    const got = await listChangedTests({ repoRoot: dir, base, head, config: loadConfig(dir) });
    assert.deepEqual(got.sort((a, b) => a.file.localeCompare(b.file)), [
      { runnerId: 'unit', file: 'test/mod.test.mjs' },
      { runnerId: 'unit', file: 'test/new.test.mjs' },
      { runnerId: 'unit', file: 'test/renamed.test.mjs' },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
