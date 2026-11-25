// Flutter adapter: runs `flutter test --machine` and classifies the JSON event stream.
import {
  LOAD_NAME, clip, fillMissing, parseJsonLine, processSummary, resolveFiles, runProcess, stripAnsi, toRepoPath,
} from './common.mjs';

/** @typedef {import('./common.mjs').TestResult} TestResult */

/**
 * Classifies `flutter test --machine` output lines (non-JSON lines are ignored).
 * - `testDone.result` `failure`/`error` on a real test → `behavior_fail`; `success` → `pass`; skipped → `skip`.
 * - The synthetic `loading <file>` test failing (compile error) → one `load_fail` for that file, but only when
 *   the suite produced no real test results: Flutter can mark another suite's loading as errored
 *   ("Dart compiler exited unexpectedly") when a sibling file fails to compile, then still run it.
 * - Hidden passing tests (successful loading, setUpAll/tearDownAll) are dropped.
 * @param {string[]} lines
 * @param {string} [root] repo root used to make absolute suite paths relative
 * @returns {TestResult[]}
 */
export function parseFlutterMachine(lines, root) {
  const suites = new Map(); // suiteID -> path
  const tests = new Map(); // testID -> { name, suiteID }
  const errors = new Map(); // testID -> error text
  /** @type {Map<string, { results: TestResult[], loadError?: string }>} */
  const byFile = new Map();
  const fileEntry = (file) => {
    if (!byFile.has(file)) byFile.set(file, { results: [] });
    return byFile.get(file);
  };

  for (const line of lines) {
    const ev = parseJsonLine(line);
    if (!ev) continue;
    if (ev.type === 'suite' && ev.suite) suites.set(ev.suite.id, ev.suite.path);
    else if (ev.type === 'testStart' && ev.test) tests.set(ev.test.id, ev.test);
    else if (ev.type === 'error') {
      const prev = errors.get(ev.testID);
      const text = [ev.error, ev.stackTrace].filter(Boolean).join('\n');
      errors.set(ev.testID, prev ? `${prev}\n${text}` : text);
    } else if (ev.type === 'testDone') {
      const t = tests.get(ev.testID);
      if (!t) continue;
      const suitePath = suites.get(t.suiteID) ?? '';
      const file = toRepoPath(suitePath, root);
      const entry = fileEntry(file);
      const failed = ev.result === 'failure' || ev.result === 'error';
      const message = clip(stripAnsi(errors.get(ev.testID) ?? ''));
      // The synthetic loading test sits outside every group; real tests always sit in at least the root group.
      if (t.name === `loading ${suitePath}` || (String(t.name).startsWith('loading ') && !t.groupIDs?.length)) {
        if (failed) entry.loadError = message || `loading failed (${ev.result})`;
        continue;
      }
      if (ev.skipped) entry.results.push({ file, name: t.name, status: 'skip' });
      else if (failed) entry.results.push({ file, name: t.name, status: 'behavior_fail', message });
      else if (!ev.hidden) entry.results.push({ file, name: t.name, status: 'pass' });
    }
  }

  /** @type {TestResult[]} */
  const out = [];
  for (const [file, e] of byFile) {
    if (e.results.length) out.push(...e.results);
    else if (e.loadError !== undefined) out.push({ file, name: LOAD_NAME, status: 'load_fail', message: e.loadError });
  }
  return out;
}

/** @type {import('./common.mjs').Runner} */
export const flutterRunner = {
  async run(opts) {
    const { root, repoFiles, argFiles } = resolveFiles(opts);
    const prefix = opts.command ?? [process.env.TRUST_KIT_FLUTTER_BIN || 'flutter', 'test'];
    const proc = await runProcess([...prefix, '--machine', ...argFiles], { cwd: opts.cwd });
    return fillMissing(parseFlutterMachine(proc.stdout.split('\n'), root), repoFiles, processSummary(proc));
  },
};
