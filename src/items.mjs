// Work items: `.trust/items/<id>.json` describes what a change touches and what it must prove.
import fs from 'node:fs';
import path from 'node:path';

export const ITEMS_DIR = '.trust/items';
export const SURFACES = /** @type {const} */ (['app', 'web', 'functions']);
export const APPROVAL_KINDS = /** @type {const} */ (['deploy-function', 'hosting', 'app-release', 'batch-write']);
const ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * @typedef {{ kind: 'deploy-function'|'hosting'|'app-release'|'batch-write', target: string }} Approval
 * @typedef {{ runnerId: string, file: string, testName: string }} ItemTest
 *   A test that proves this item: it must fail on base by behavior and pass on head in the CI red-green report.
 *   `testName` is the test's name, or the last part of a nested name (`parent > child`, Jest `describe test`).
 * @typedef {{ id: string, title: string, surfaces: ('app'|'web'|'functions')[], acceptance: string[], approvals: Approval[],
 *   tests: ItemTest[] }} Item
 *   `tests` is optional in the file (defaults to []), but evidence is never complete for an item without tests.
 */

/** @param {string} id */
export function assertItemId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new ItemError(`invalid item id ${JSON.stringify(id)}: use only letters, digits, "_" and "-"`);
  }
}

/** Bad item id or item file; the CLI prints it without a stack. */
export class ItemError extends Error {}

const isStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * @param {string} repoRoot @param {string} id
 * @returns {Item}
 */
export function loadItem(repoRoot, id) {
  assertItemId(id);
  const file = path.join(repoRoot, ITEMS_DIR, `${id}.json`);
  const shown = `${ITEMS_DIR}/${id}.json`;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ItemError(`${shown}: cannot read item (${e.code ?? e.message}). Fix: create ${ITEMS_DIR}/${id}.json`);
  }
  return validateItem(raw, id, shown);
}

/**
 * Validates parsed item JSON (e.g. read from a commit). Throws ItemError naming the file and field.
 * @param {unknown} raw @param {string} id expected id (the file name without .json) @param {string} shown file label
 * @returns {Item}
 */
export function validateItem(raw, id, shown) {
  assertItemId(id);
  const fail = (field, problem) => { throw new ItemError(`${shown}: ${field}: ${problem}`); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('(root)', 'must be a JSON object');
  if (raw.id !== id) fail('id', `must equal the file name "${id}"`);
  if (!isStr(raw.title)) fail('title', 'must be a non-empty string');
  if (!Array.isArray(raw.surfaces) || raw.surfaces.length === 0 || !raw.surfaces.every((s) => SURFACES.includes(s))) {
    fail('surfaces', `must be a non-empty array of ${SURFACES.join(', ')}`);
  }
  if (!Array.isArray(raw.acceptance) || !raw.acceptance.every(isStr)) fail('acceptance', 'must be an array of strings');
  if (!Array.isArray(raw.approvals) || !raw.approvals.every((a) => a && APPROVAL_KINDS.includes(a.kind) && isStr(a.target))) {
    fail('approvals', `must be an array of { kind: ${APPROVAL_KINDS.join('|')}, target: string }`);
  }
  if (raw.tests !== undefined && (!Array.isArray(raw.tests)
    || !raw.tests.every((t) => t && isStr(t.runnerId) && isStr(t.file) && isStr(t.testName)))) {
    fail('tests', 'must be an array of { runnerId: string, file: string (repo-relative), testName: string }');
  }
  return {
    id, title: raw.title, surfaces: [...new Set(raw.surfaces)], acceptance: [...raw.acceptance],
    approvals: raw.approvals.map((a) => ({ kind: a.kind, target: a.target })),
    tests: (raw.tests ?? []).map((t) => ({ runnerId: t.runnerId, file: t.file, testName: t.testName })),
  };
}
