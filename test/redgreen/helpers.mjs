// Shared helpers for red-green tests (not a test file itself): throwaway git repos in the OS temp dir.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @param {string} cwd @param {string[]} args */
export const git = (cwd, ...args) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
  { cwd, encoding: 'utf8' }).trim();

/** Creates an empty git repo in a realpath'd temp dir. */
export function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-rg-')));
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

/** @param {string} dir @param {Record<string, string|null>} files null deletes */
export function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (text === null) { fs.rmSync(p, { force: true }); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}

/** Writes files, commits everything, returns the commit SHA. */
export function commit(dir, files, msg = 'c') {
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

export const nodeTestConfig = (globs = ['test/**/*.test.mjs']) => JSON.stringify({
  version: 1,
  runners: [{ id: 'unit', adapter: 'node-test', cwd: '.', testGlobs: globs }],
  evidence: { outDir: '.trust/evidence', screensDir: '.trust/screens' },
  ledger: { path: '.trust/ledger.md' },
});

/** Worktrees other than the main one. */
export const extraWorktrees = (dir) => git(dir, 'worktree', 'list', '--porcelain')
  .split('\n').filter((l) => l.startsWith('worktree ')).slice(1);
