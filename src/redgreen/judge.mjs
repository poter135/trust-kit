// Pure red/green judgement: did the changed tests fail on base by behavior and pass on head?

/**
 * @typedef {'pass'|'behavior_fail'|'load_fail'|'skip'} Status
 * @typedef {'valid_red'|'invalid_red'|'no_red'|'head_fail'|'no_tests'} Verdict
 * @typedef {{ file: string, name: string, base: Status|'absent', head: Status|'absent' }} JudgedTest
 *   `head` is `absent` only for a result seen on base alone (e.g. the base `(load)` failure of a file).
 * @typedef {{ verdict: Verdict, tests: JudgedTest[] }} RedGreenJudgement
 * @typedef {{ file: string, name: string, status: Status }} Result
 */

/**
 * True when a judged row's name is `testName`: the exact name, or whole trailing ` > ` segments of a nested name
 * (`describe > test`; node:test and Jest both report nesting this way). A sibling whose name only ends with the
 * same words does not match.
 * @param {string} rowName @param {string} testName
 */
export function matchesTestName(rowName, testName) {
  return rowName === testName || rowName.endsWith(` > ${testName}`);
}

/** A row that proves a red: it failed on base by behavior and passes on head. @param {JudgedTest} t */
export const isRedToGreen = (t) => t.base === 'behavior_fail' && t.head === 'pass';

/**
 * Rules, in order: no changed tests → no_tests; any changed-test result on head other than pass/skip →
 * head_fail; some test failing on base by behavior and passing on head → valid_red; otherwise any load_fail or
 * behavior_fail on base (e.g. a failing test that was renamed or removed on head) → invalid_red;
 * otherwise no_red. Only results for changed test files are considered.
 * @param {{ changed: { runnerId: string, file: string }[], baseResults: Result[], headResults: Result[] }} input
 * @returns {RedGreenJudgement}
 */
export function judgeRedGreen({ changed, baseResults, headResults }) {
  if (changed.length === 0) return { verdict: 'no_tests', tests: [] };
  const files = new Set(changed.map((c) => c.file));
  const base = baseResults.filter((r) => files.has(r.file));
  const head = headResults.filter((r) => files.has(r.file));

  /** @type {Map<string, JudgedTest>} */
  const rows = new Map();
  const key = (r) => `${r.file}\0${r.name}`;
  for (const r of head) rows.set(key(r), { file: r.file, name: r.name, base: 'absent', head: r.status });
  for (const r of base) {
    const row = rows.get(key(r));
    if (row) row.base = r.status;
    else rows.set(key(r), { file: r.file, name: r.name, base: r.status, head: 'absent' });
  }
  const tests = [...rows.values()].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));

  /** @type {Verdict} */
  let verdict;
  if (head.length === 0 || head.some((r) => r.status !== 'pass' && r.status !== 'skip')) verdict = 'head_fail';
  else if (tests.some(isRedToGreen)) verdict = 'valid_red';
  else if (base.some((r) => r.status === 'load_fail' || r.status === 'behavior_fail')) verdict = 'invalid_red';
  else verdict = 'no_red';
  return { verdict, tests };
}

const PRIORITY = /** @type {const} */ (['head_fail', 'valid_red', 'invalid_red', 'no_red']);

/**
 * Overall verdict across runners: the worst-for-the-change wins in the order head_fail, valid_red,
 * invalid_red, no_red; no_tests only when every runner had none.
 * @param {Verdict[]} verdicts @returns {Verdict}
 */
export function combineVerdicts(verdicts) {
  return PRIORITY.find((v) => verdicts.includes(v)) ?? 'no_tests';
}
