// node:test adapter: runs `node --test` with trust-kit's JSON-lines reporter.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOAD_NAME, FILE_NAME, clip, fillMissing, parseJsonLine, processSummary, resolveFiles, runProcess, stripAnsi, toRepoPath,
} from './common.mjs';

/** @typedef {import('./common.mjs').TestResult} TestResult */

const REPORTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node-test-reporter.mjs');

/**
 * Classifies node-test-reporter.mjs output.
 * - A file-level failure with no test results from that file → one `load_fail` for the file
 *   (the file never got as far as running a test: import/syntax errors, top-level throws).
 * - A file-level failure after the file produced test results → an extra `(file)` `load_fail`.
 * - A failing test → `behavior_fail`; skip/todo → `skip`.
 * Messages for file-level results carry the file's stderr and error diagnostics.
 * - Suites, and parents failing only because a subtest failed, are not reported separately;
 *   nested tests are named `parent > child`.
 * @param {string[]} lines
 * @param {string} [root] repo root used to make absolute paths relative
 * @returns {TestResult[]}
 */
export function parseNodeTestEvents(lines, root) {
  /** @type {Map<string, { pending: any[], fileFail?: any, stderr: string }>} */
  const byFile = new Map();
  const entry = (file) => {
    if (!byFile.has(file)) byFile.set(file, { pending: [], stderr: '' });
    return byFile.get(file);
  };
  for (const line of lines) {
    const ev = parseJsonLine(line);
    if (!ev || !ev.file) continue;
    const e = entry(ev.file);
    if (ev.type === 'stderr' || ev.type === 'diagnostic') { e.stderr += `${ev.message ?? ''}${ev.type === 'diagnostic' ? '\n' : ''}`; continue; }
    if (ev.type !== 'pass' && ev.type !== 'fail') continue;
    if (ev.isFile) {
      if (ev.type === 'fail') e.fileFail ??= ev;
      continue;
    }
    // Subtests are reported before their parent: everything pending that is nested deeper belongs to it.
    const node = { ...ev, children: [] };
    while (e.pending.length && e.pending[e.pending.length - 1].nesting > ev.nesting) {
      node.children.unshift(e.pending.pop());
    }
    e.pending.push(node);
  }

  /** @type {TestResult[]} */
  const out = [];
  for (const [absFile, e] of byFile) {
    const file = toRepoPath(absFile, root);
    const emit = (node, prefix) => {
      const name = prefix ? `${prefix} > ${node.name}` : node.name;
      node.children.forEach((c) => emit(c, name));
      const onlySubtests = node.type === 'fail' && node.failureType === 'subtestsFailed';
      if (node.suite || (node.children.length && (node.type === 'pass' || onlySubtests))) return;
      if (node.skip || node.todo) out.push({ file, name, status: 'skip' });
      else if (node.type === 'pass') out.push({ file, name, status: 'pass' });
      else out.push({ file, name, status: 'behavior_fail', message: clip(stripAnsi(node.message ?? '')) });
    };
    e.pending.forEach((n) => emit(n, ''));
    const hadTests = e.pending.length > 0;
    if (e.fileFail && !hadTests) {
      out.push({ file, name: LOAD_NAME, status: 'load_fail', message: clip(stripAnsi(e.stderr || e.fileFail.message || '')) });
    } else if (e.fileFail && e.fileFail.failureType !== 'subtestsFailed') {
      // A file-level failure outside any test (e.g. a top-level `await import()` that throws after tests were
      // registered) is not evidence that a test's behavior failed, so it must never count as a valid red.
      out.push({ file, name: FILE_NAME, status: 'load_fail', message: clip(stripAnsi(e.stderr || e.fileFail.message || '')) });
    }
  }
  return out;
}

/** @type {import('./common.mjs').Runner} */
export const nodeTestRunner = {
  async run(opts) {
    const { root, repoFiles, argFiles } = resolveFiles(opts);
    const prefix = opts.command ?? [process.execPath, '--test'];
    // When trust-kit itself runs under `node --test`, NODE_TEST_CONTEXT would make the child report to the
    // parent test runner instead of using our reporter.
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const proc = await runProcess([...prefix, `--test-reporter=${REPORTER}`, ...argFiles], { cwd: opts.cwd, env });
    return fillMissing(parseNodeTestEvents(proc.stdout.split('\n'), root), repoFiles, processSummary(proc));
  },
};
