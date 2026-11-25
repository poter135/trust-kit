// Jest adapter: runs Jest with --json --outputFile and classifies the report.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOAD_NAME, FILE_NAME, clip, fillMissing, processSummary, resolveFiles, runProcess, stripAnsi, toRepoPath,
} from './common.mjs';

/** @typedef {import('./common.mjs').TestResult} TestResult */

/**
 * Classifies a Jest `--json` report.
 * - `assertionResults[].status === 'failed'` → `behavior_fail`; passed → `pass`; pending/todo/skipped → `skip`.
 * - A failed suite with no assertion results → one `load_fail` for the file (includes ts-jest type errors).
 * - A failed suite whose assertions all passed (e.g. afterAll threw) → an extra `(file)` `behavior_fail`.
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
      const name = a.fullName || [...(a.ancestorTitles ?? []), a.title].join(' ');
      if (a.status === 'passed') out.push({ file, name, status: 'pass' });
      else if (a.status === 'failed') {
        anyFailed = true;
        out.push({ file, name, status: 'behavior_fail', message: clip(stripAnsi((a.failureMessages ?? []).join('\n'))) });
      } else out.push({ file, name, status: 'skip' });
    }
    if (suite.status === 'failed' && !anyFailed) {
      out.push({ file, name: FILE_NAME, status: 'behavior_fail', message: suiteMessage });
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
