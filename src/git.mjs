// Thin wrappers over the git CLI (execFile, no shell).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} cwd @param {string[]} args
 * @returns {Promise<string>} stdout (untrimmed)
 */
export function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** @param {string} cwd @returns {Promise<string>} absolute top-level directory of the repo containing cwd */
export async function repoTopLevel(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/** @param {string} repoRoot @param {string} rev @returns {Promise<string>} full commit SHA */
export async function resolveCommit(repoRoot, rev) {
  return (await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`])).trim();
}

/**
 * `git diff --name-status` between two revs. Renames are reported as a delete plus an add.
 * @param {string} repoRoot @param {string} base @param {string} head
 * @returns {Promise<{ status: string, path: string }[]>} status is git's letter (A, M, D, T, …)
 */
export async function diffNameStatus(repoRoot, base, head) {
  const out = await git(repoRoot, ['diff', '--name-status', '--no-renames', '-z', base, head, '--']);
  const parts = out.split('\0').filter((s) => s !== '');
  const res = [];
  for (let i = 0; i + 1 < parts.length; i += 2) res.push({ status: parts[i][0], path: parts[i + 1] });
  return res;
}

/** @param {string} repoRoot @param {string} rev @param {string} file repo-relative @returns {Promise<Buffer>} */
export function showFile(repoRoot, rev, file) {
  return new Promise((resolve, reject) => {
    execFile('git', ['show', `${rev}:${file}`], { cwd: repoRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git show ${rev}:${file} failed: ${String(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/**
 * Checks `rev` out (detached) into a fresh temp directory, calls `fn(dir)`, and always removes the worktree.
 * @template T
 * @param {string} repoRoot @param {string} rev @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withWorktree(repoRoot, rev, fn) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trust-kit-wt-')));
  const dir = path.join(tmp, 'wt');
  try {
    await git(repoRoot, ['worktree', 'add', '--detach', '--quiet', dir, rev]);
    return await fn(dir);
  } finally {
    await git(repoRoot, ['worktree', 'remove', '--force', dir]).catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true });
    await git(repoRoot, ['worktree', 'prune']).catch(() => {});
  }
}
