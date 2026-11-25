// Jest adapter: runs Jest with --json --outputFile and classifies the report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOAD_NAME, FILE_NAME, clip, fillMissing, isModuleNotFound, processSummary, resolveFiles, runProcess, stripAnsi, toRepoPath,
} from './common.mjs';

/** @typedef {import('./common.mjs').TestResult} TestResult */

/**
 * Classifies a Jest `--json` report.
 * - `assertionResults[].status === 'failed'` → `behavior_fail` (`load_fail` when the failure says a module could not
 *   be found); passed → `pass`; pending/todo/skipped → `skip`.
 * - A failed suite with no assertion results → one `load_fail` for the file (includes ts-jest type errors).
 * - A failed suite whose assertions all passed (e.g. afterAll threw) → an extra `(file)` `load_fail`
 *   carrying the suite's error message (never `behavior_fail`: no test's behavior was shown to fail).
 * @param {any} json parsed Jest JSON report
 * @param {string} cwd repo root used to make Jest's absolute paths relative
 * @returns {TestResult[]}
 */
export function parseJestJson(json, cwd) {
  /** @type {TestResult[]} */
  const out = [];
  for (const suite of json?.testResults ?? []) {
    const file = toRepoPath(suite.name ?? suite.testFilePath ?? '', cwd);
    const assertions = suite.assertionResults ?? [];
    const suiteMessage = clip(stripAnsi(suite.message ?? suite.failureMessage ?? ''));
    if (suite.status === 'failed' && assertions.length === 0) {
      out.push({ file, name: LOAD_NAME, status: 'load_fail', message: suiteMessage });
      continue;
    }
    let anyFailed = false;
    for (const a of assertions) {
      // Nesting is joined with " > " like node:test, so a test name can only match whole segments.
      const name = typeof a.title === 'string' ? [...(a.ancestorTitles ?? []), a.title].join(' > ') : String(a.fullName ?? '');
      if (a.status === 'passed') out.push({ file, name, status: 'pass' });
      else if (a.status === 'failed') {
        anyFailed = true;
        const message = clip(stripAnsi((a.failureMessages ?? []).join('\n')));
        out.push({ file, name, status: isModuleNotFound(message) ? 'load_fail' : 'behavior_fail', message });
      } else out.push({ file, name, status: 'skip' });
    }
    if (suite.status === 'failed' && !anyFailed) {
      // A suite-level error outside any test (hook, top-level code after tests were defined) is not
      // evidence that a test's behavior failed, so it must never count as a valid red.
      out.push({ file, name: FILE_NAME, status: 'load_fail', message: suiteMessage });
    }
  }
  return out;
}

/** @type {import('./common.mjs').Runner} */
export const jestRunner = {
  async run(opts) {
    const { root, repoFiles, argFiles } = resolveFiles(opts);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-kit-jest-'));
    const outFile = path.join(tmp, 'report.json');
    try {
      const prefix = opts.command ?? ['npx', 'jest'];
      const proc = await runProcess(
        [...prefix, '--json', `--outputFile=${outFile}`, '--runTestsByPath', ...argFiles],
        { cwd: opts.cwd },
      );
      let results = [];
      if (fs.existsSync(outFile)) {
        try {
          results = parseJestJson(JSON.parse(fs.readFileSync(outFile, 'utf8')), root);
        } catch (e) {
          proc.stderr += `\ncannot parse Jest report: ${e.message}`;
        }
      }
      return fillMissing(results, repoFiles, processSummary(proc));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};
