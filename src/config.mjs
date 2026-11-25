// Loads and validates <repoRoot>/trust.config.json. Hand-written validation, no schema library.
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = 'trust.config.json';
export const ADAPTERS = /** @type {const} */ (['flutter', 'jest', 'node-test']);
/** Files that guard trust-kit itself; always protected even if the user omits them. */
export const ALWAYS_PROTECTED = Object.freeze(['trust.config.json', 'tools/trust-kit.version', '.trust/rules.json']);

/**
 * @typedef {{ id: string, adapter: 'flutter'|'jest'|'node-test', cwd: string, testGlobs: string[], command?: string[], setup?: string[][] }} RunnerConfig
 *   `setup`: argv arrays run (no shell) in the runner's cwd of each temporary checkout before its tests,
 *   e.g. [["npm", "ci"]] — temporary checkouts have no installed dependencies.
 * @typedef {{ version: 1, runners: RunnerConfig[], protectedPaths: string[],
 *   evidence: { outDir: string, screensDir: string }, ledger: { path: string } }} TrustConfig
 */

export class TrustConfigError extends Error {
  /** @param {string} field @param {string} problem @param {string} fix @param {string} [file] */
  constructor(field, problem, fix, file) {
    super(`${file ? `${file}: ` : ''}${field}: ${problem}. Fix: ${fix}`);
    this.name = 'TrustConfigError';
    this.field = field;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * @param {string} repoRoot
 * @returns {TrustConfig}
 */
export function loadConfig(repoRoot) {
  const file = path.join(repoRoot, CONFIG_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new TrustConfigError(CONFIG_FILE, `cannot read ${file} (${e.code ?? e.message})`,
      `create ${CONFIG_FILE} at the repo root`);
  }
  return parseConfig(text, file);
}

/**
 * Parses and validates config JSON text. @param {string} text @param {string} file label used in error messages
 * @returns {TrustConfig}
 */
export function parseConfig(text, file) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new TrustConfigError('(root)', `invalid JSON (${e.message})`, 'make the file valid JSON', file);
  }
  const fail = (field, problem, fix) => { throw new TrustConfigError(field, problem, fix, file); };
  const str = (v, field) => { if (!isStr(v)) fail(field, 'must be a non-empty string', `set "${field}" to a string`); return v; };
  const strArr = (v, field, { nonEmpty = false } = {}) => {
    if (!Array.isArray(v)) fail(field, 'must be an array of strings', `set "${field}" to e.g. ["..."]`);
    if (nonEmpty && v.length === 0) fail(field, 'must not be empty', `add at least one entry to "${field}"`);
    v.forEach((s, i) => str(s, `${field}[${i}]`));
    return [...v];
  };

  if (!isObj(raw)) fail('(root)', 'must be a JSON object', 'wrap the config in { ... }');
  if (raw.version === undefined) fail('version', 'is missing', 'add "version": 1');
  if (raw.version !== 1) fail('version', `unsupported value ${JSON.stringify(raw.version)}`, 'set "version": 1');

  if (!Array.isArray(raw.runners) || raw.runners.length === 0) {
    fail('runners', 'must be a non-empty array', 'add at least one runner { id, adapter, cwd, testGlobs }');
  }
  const ids = new Set();
  const runners = raw.runners.map((r, i) => {
    const at = `runners[${i}]`;
    if (!isObj(r)) fail(at, 'must be an object', `make ${at} an object { id, adapter, cwd, testGlobs }`);
    const id = str(r.id, `${at}.id`);
    if (ids.has(id)) fail(`${at}.id`, `duplicate id "${id}"`, 'give each runner a unique id');
    ids.add(id);
    if (!ADAPTERS.includes(r.adapter)) {
      fail(`${at}.adapter`, `unknown adapter ${JSON.stringify(r.adapter)}`, `use one of: ${ADAPTERS.join(', ')}`);
    }
    /** @type {RunnerConfig} */
    const out = { id, adapter: r.adapter, cwd: str(r.cwd, `${at}.cwd`), testGlobs: strArr(r.testGlobs, `${at}.testGlobs`, { nonEmpty: true }) };
    if (r.command !== undefined) out.command = strArr(r.command, `${at}.command`, { nonEmpty: true });
    if (r.setup !== undefined) {
      if (!Array.isArray(r.setup)) fail(`${at}.setup`, 'must be an array of argv arrays', `set "${at}.setup" to e.g. [["npm", "ci"]]`);
      out.setup = r.setup.map((cmd, j) => strArr(cmd, `${at}.setup[${j}]`, { nonEmpty: true }));
    }
    return out;
  });

  const userProtected = raw.protectedPaths === undefined ? [] : strArr(raw.protectedPaths, 'protectedPaths');
  const protectedPaths = [...new Set([...ALWAYS_PROTECTED, ...userProtected])];

  if (!isObj(raw.evidence)) fail('evidence', 'must be an object', 'add "evidence": { "outDir": "...", "screensDir": "..." }');
  if (!isObj(raw.ledger)) fail('ledger', 'must be an object', 'add "ledger": { "path": "..." }');

  return {
    version: 1,
    runners,
    protectedPaths,
    evidence: { outDir: str(raw.evidence.outDir, 'evidence.outDir'), screensDir: str(raw.evidence.screensDir, 'evidence.screensDir') },
    ledger: { path: str(raw.ledger.path, 'ledger.path') },
  };
}
