// Helpers shared by the runner adapters. Only adapters (inside src/runners/) import this file.
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Name used for the single result that stands for a whole file which never loaded. */
export const LOAD_NAME = '(load)';
/** Name used for a file-level failure that happened after the file loaded and produced test results. */
export const FILE_NAME = '(file)';

/**
 * @typedef {{ file: string, name: string, status: 'pass'|'behavior_fail'|'load_fail'|'skip', message?: string }} TestResult
 *   `file` is relative to the repo root, with `/` separators.
 * @typedef {{ cwd: string, files: string[], command?: string[], repoRoot?: string }} RunOptions
 *   - `cwd`: absolute directory the test tool runs in (repo root joined with the runner's configured `cwd`).
 *   - `repoRoot`: absolute repo root; every `TestResult.file` is relative to it. Defaults to `cwd`.
 *   - `files`: test files, absolute or relative to `repoRoot` (the same form `testGlobs` match).
 *   - `command`: replaces the adapter's default command prefix; the adapter always appends its own
 *     required flags (machine-readable output) and the files.
 * @typedef {{ run(opts: RunOptions): Promise<TestResult[]> }} Runner
 */

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
/** @param {string} s */
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

/** @param {string} s @param {number} [max] keep the end, where the real error usually is */
export const clip = (s, max = 4000) => (s.length > max ? `…${s.slice(-max)}` : s);

/**
 * Turns a tool-reported path into a repo-relative, `/`-separated path.
 * @param {string} p @param {string} [root] when omitted, the path is returned unchanged (apart from separators)
 */
export function toRepoPath(p, root) {
  let out = p.startsWith('file://') ? new URL(p).pathname : p;
  if (root && path.isAbsolute(out)) out = path.relative(root, out);
  return out.split(path.sep).join('/');
}

/**
 * @param {RunOptions} opts
 * @returns {{ root: string, repoFiles: string[], absFiles: string[], argFiles: string[] }}
 *   `argFiles` are relative to `cwd`, which is how they are passed on the command line.
 */
export function resolveFiles({ cwd, files, repoRoot }) {
  const root = repoRoot ?? cwd;
  const absFiles = files.map((f) => path.resolve(root, f));
  return {
    root,
    absFiles,
    repoFiles: absFiles.map((f) => toRepoPath(f, root)),
    argFiles: absFiles.map((f) => path.relative(cwd, f) || '.'),
  };
}

/**
 * Every requested file that produced no result at all is reported as `load_fail`: nothing proves it ran,
 * so it must never count as a behavior failure (or as a pass).
 * @param {TestResult[]} results @param {string[]} repoFiles @param {string} message
 * @returns {TestResult[]}
 */
export function fillMissing(results, repoFiles, message) {
  const seen = new Set(results.map((r) => r.file));
  const missing = repoFiles.filter((f) => !seen.has(f))
    .map((file) => ({ file, name: LOAD_NAME, status: /** @type {const} */ ('load_fail'), message }));
  return [...results, ...missing];
}

/**
 * Runs a command without a shell and collects its output. Spawn errors (e.g. binary not found) resolve
 * with `code: null` and the error text in `stderr` instead of throwing.
 * @param {string[]} argv @param {{ cwd: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
export function runProcess(argv, { cwd, env }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout, stderr: `failed to start ${argv[0]}: ${e.message}` });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += `failed to start ${argv[0]}: ${e.message}\n`; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** @param {string} line @returns {any} parsed object, or undefined for non-JSON lines */
export function parseJsonLine(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** @param {{ code: number|null, stderr: string }} proc */
export const processSummary = (proc) =>
  `no test results reported (exit ${proc.code ?? 'spawn error'})${proc.stderr.trim() ? `: ${clip(stripAnsi(proc.stderr.trim()), 2000)}` : ''}`;
