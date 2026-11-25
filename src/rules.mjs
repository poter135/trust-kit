// Rules registry (<repoRoot>/.trust/rules.json): which prose rules a project now enforces with a machine check.
import fs from 'node:fs';
import path from 'node:path';
import { git, showFile } from './git.mjs';
import { isRedToGreen, matchesTestName } from './redgreen/judge.mjs';

export const RULES_FILE = '.trust/rules.json';
export const LAYERS = /** @type {const} */ (['structure', 'machine', 'runtime', 'prose', 'human']);
export const STATUSES = /** @type {const} */ (['prose', 'enforced']);
const FIX_CHECK = '補上檢查或把 status 改回 prose';

/**
 * @typedef {{ runnerId: string, file: string, testName: string }} RuleCheck
 *   `file` is repo-relative; `testName` must appear verbatim in it.
 * @typedef {{ id: string, source: string, summary: string, layer: typeof LAYERS[number], status: typeof STATUSES[number],
 *   check?: RuleCheck, violations?: number }} Rule
 *   `source` is `<repo-relative path>#<anchor>`.
 * @typedef {{ version: 1, rules: Rule[] }} RulesFile
 * @typedef {{ ruleId: string, problem: string, fix: string }} RuleProblem
 */

export class RulesError extends Error {
  /** @param {string} field @param {string} problem @param {string} fix @param {string} label */
  constructor(field, problem, fix, label) {
    super(`${label}: ${field}: ${problem}. Fix: ${fix}`);
    this.name = 'RulesError';
    this.field = field;
  }
}

/** The marker a rule's source document must contain once the rule is enforced. @param {string} id */
export const ruleMarker = (id) => `〔機器化：${id}〕`;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Parses and validates rules JSON text. @param {string} text @param {string} label used in error messages
 * @returns {RulesFile}
 */
export function parseRules(text, label) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RulesError('(root)', `invalid JSON (${e.message})`, 'make the file valid JSON', label);
  }
  const fail = (field, problem, fix) => { throw new RulesError(field, problem, fix, label); };
  const str = (v, field) => { if (!isStr(v)) fail(field, 'must be a non-empty string', `set "${field}" to a string`); return v; };
  if (!isObj(raw)) fail('(root)', 'must be a JSON object', 'wrap the file in { "version": 1, "rules": [] }');
  if (raw.version !== 1) fail('version', `unsupported value ${JSON.stringify(raw.version)}`, 'set "version": 1');
  if (!Array.isArray(raw.rules)) fail('rules', 'must be an array', 'set "rules": []');
  const ids = new Set();
  const rules = raw.rules.map((r, i) => {
    const at = `rules[${i}]`;
    if (!isObj(r)) fail(at, 'must be an object', `make ${at} an object { id, source, summary, layer, status }`);
    const id = str(r.id, `${at}.id`);
    if (ids.has(id)) fail(`${at}.id`, `duplicate id "${id}"`, 'give each rule a unique id');
    ids.add(id);
    const source = str(r.source, `${at}.source`);
    if (!source.includes('#') || source.startsWith('#')) {
      fail(`${at}.source`, `must be "<path>#<anchor>", got ${JSON.stringify(source)}`, 'point source at the rule\'s heading, e.g. "docs/rules.md#no-delete"');
    }
    if (!LAYERS.includes(r.layer)) fail(`${at}.layer`, `unknown layer ${JSON.stringify(r.layer)}`, `use one of: ${LAYERS.join(', ')}`);
    if (!STATUSES.includes(r.status)) fail(`${at}.status`, `unknown status ${JSON.stringify(r.status)}`, `use one of: ${STATUSES.join(', ')}`);
    /** @type {Rule} */
    const out = { id, source, summary: str(r.summary, `${at}.summary`), layer: r.layer, status: r.status };
    if (r.check !== undefined) {
      if (!isObj(r.check)) fail(`${at}.check`, 'must be an object', `set "${at}.check" to { runnerId, file, testName }`);
      out.check = { runnerId: str(r.check.runnerId, `${at}.check.runnerId`), file: str(r.check.file, `${at}.check.file`),
        testName: str(r.check.testName, `${at}.check.testName`) };
    }
    if (r.violations !== undefined) {
      if (!Number.isInteger(r.violations) || r.violations < 0) fail(`${at}.violations`, 'must be a non-negative integer', 'set a count or remove the field');
      out.violations = r.violations;
    }
    return out;
  });
  return { version: 1, rules };
}

/** A missing rules file means no rules. @param {string} repoRoot @returns {RulesFile} */
export function loadRules(repoRoot) {
  const file = path.join(repoRoot, RULES_FILE);
  if (!fs.existsSync(file)) return { version: 1, rules: [] };
  return parseRules(fs.readFileSync(file, 'utf8'), file);
}

/**
 * Rules file as committed at `rev`; absent at that rev means no rules.
 * @param {string} repoRoot @param {string} rev commit SHA @returns {Promise<RulesFile>}
 */
export async function loadRulesAt(repoRoot, rev) {
  const listed = await git(repoRoot, ['ls-tree', '--name-only', rev, '--', RULES_FILE]);
  if (listed.trim() === '') return { version: 1, rules: [] };
  return parseRules((await showFile(repoRoot, rev, RULES_FILE)).toString('utf8'), `${rev.slice(0, 12)}:${RULES_FILE}`);
}

/**
 * Ids enforced on head but not on base (absent on base counts as not enforced), in head order.
 * @param {RulesFile} base @param {RulesFile} head @returns {string[]}
 */
export function newlyEnforcedIds(base, head) {
  const was = new Set(base.rules.filter((r) => r.status === 'enforced').map((r) => r.id));
  return head.rules.filter((r) => r.status === 'enforced' && !was.has(r.id)).map((r) => r.id);
}

/** Reads a repo-relative file, refusing paths that leave the repo. @returns {string|null} null when missing or outside */
function readInRepo(repoRoot, rel) {
  const relBack = path.relative(repoRoot, path.resolve(repoRoot, rel));
  if (relBack === '' || relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  try {
    return fs.readFileSync(path.join(repoRoot, relBack), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Every enforced rule must name a check whose file exists and contains `testName`, and its source document must
 * carry the marker `〔機器化：<id>〕`. Invalid rules JSON throws RulesError.
 * @param {{ repoRoot: string }} opts @returns {{ ok: boolean, problems: RuleProblem[] }}
 */
export function verifyRules({ repoRoot }) {
  /** @type {RuleProblem[]} */
  const problems = [];
  for (const rule of loadRules(repoRoot).rules) {
    if (rule.status !== 'enforced') continue;
    const add = (problem, fix) => problems.push({ ruleId: rule.id, problem: `rule "${rule.id}": ${problem}`, fix });
    if (!rule.check) {
      add('status is enforced but it has no check', `${FIX_CHECK}（加上 check: { runnerId, file, testName }）`);
    } else {
      const text = readInRepo(repoRoot, rule.check.file);
      if (text === null) add(`check file ${rule.check.file} does not exist in the repo`, FIX_CHECK);
      else if (!text.includes(rule.check.testName)) {
        add(`check file ${rule.check.file} does not contain test name ${JSON.stringify(rule.check.testName)}`,
          `${FIX_CHECK}（或把 check.testName 改成該檔內實際的測試名稱）`);
      }
    }
    const marker = ruleMarker(rule.id);
    const srcFile = rule.source.slice(0, rule.source.indexOf('#'));
    const src = readInRepo(repoRoot, srcFile);
    if (src === null) add(`source file ${srcFile} does not exist in the repo`, `fix "source" to point at the rule's document, then add ${marker} there`);
    else if (!src.includes(marker)) add(`source file ${srcFile} lacks the marker ${marker}`, `在 ${rule.source} 的規則文字旁加上 ${marker}`);
  }
  return { ok: problems.length === 0, problems };
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Markdown table of all rules. @param {{ repoRoot: string }} opts @returns {string} */
export function rulesReport({ repoRoot }) {
  const lines = ['| id | 摘要 | 層級 | 狀態 | 負責的檢查 |', '| --- | --- | --- | --- | --- |'];
  for (const r of loadRules(repoRoot).rules) {
    const check = r.check ? `${r.check.runnerId}: ${r.check.file} › ${r.check.testName}` : '—';
    lines.push(`| ${[r.id, r.summary, r.layer, r.status, check].map(cell).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Problems for newly enforced rules whose check did not go red→green in this change: the check file must be among
 * the changed tests of its runner, with at least one row `behavior_fail` on base and `pass` on head.
 * @param {{ ids: string[], head: RulesFile, runners: { id: string, tests: import('./redgreen/judge.mjs').JudgedTest[] }[] }} input
 * @returns {{ ruleId: string, problem: string }[]}
 */
export function ruleEvidenceProblems({ ids, head, runners }) {
  const out = [];
  for (const id of ids) {
    const rule = head.rules.find((r) => r.id === id);
    if (!rule?.check) { out.push({ ruleId: id, problem: `rule "${id}" became enforced without a check` }); continue; }
    const { runnerId, file, testName } = rule.check;
    const rows = (runners.find((r) => r.id === runnerId)?.tests ?? []).filter((t) => t.file === file);
    if (rows.length === 0) {
      out.push({ ruleId: id, problem: `rule "${id}" became enforced but its check ${file} (runner ${runnerId}) is not among the changed tests` });
    } else {
      const mine = rows.filter((t) => matchesTestName(t.name, testName));
      if (mine.length > 1) {
        out.push({ ruleId: id, problem: `rule "${id}": check test name ${JSON.stringify(testName)} matches ${mine.length} tests in ${file}; use the full name` });
      } else if (!mine.some(isRedToGreen)) {
        out.push({ ruleId: id, problem: `rule "${id}" became enforced but its check test ${JSON.stringify(testName)} in ${file} did not fail on base by behavior and pass on head` });
      }
    }
  }
  return out;
}
