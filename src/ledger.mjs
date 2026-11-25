// Append-only trust ledger: one JSON object per line. Past lines must never change.
import fs from 'node:fs';
import path from 'node:path';
import { git, mergeBase, resolveCommit, showFile } from './git.mjs';

export const LEDGER_KINDS = /** @type {const} */ (['claim', 'review', 'release', 'reopen', 'deviation']);

/**
 * @typedef {{ kind: typeof LEDGER_KINDS[number], item: string, commit: string, at?: string, [k: string]: unknown }} LedgerEntry
 *   `at` (ISO timestamp) is filled in when absent.
 */

/**
 * Appends exactly one JSON line. Throws (writing nothing) on an unknown `kind` or empty `item`/`commit`.
 * @param {string} file @param {LedgerEntry} entry
 */
export function appendLedger(file, entry) {
  if (entry === null || typeof entry !== 'object') throw new TypeError('ledger entry must be an object');
  if (!LEDGER_KINDS.includes(entry.kind)) throw new TypeError(`ledger entry kind ${JSON.stringify(entry.kind)} must be one of: ${LEDGER_KINDS.join(', ')}`);
  for (const f of ['item', 'commit']) {
    if (typeof entry[f] !== 'string' || entry[f] === '') throw new TypeError(`ledger entry ${f} must be a non-empty string`);
  }
  const line = `${JSON.stringify({ ...entry, at: entry.at ?? new Date().toISOString() })}\n`;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, line);
}

/** @returns {Promise<string|null>} file text at rev, null when absent */
async function readAt(repoRoot, rev, file) {
  const listed = await git(repoRoot, ['ls-tree', '--name-only', rev, '--', file]);
  if (listed.trim() === '') return null;
  return (await showFile(repoRoot, rev, file)).toString('utf8');
}

/**
 * Head's ledger must start with merge-base(base, head)'s ledger byte for byte (pure append).
 * Absent on the merge-base is ok; present there but absent on head is not.
 * @param {{ repoRoot: string, path: string, base: string, head?: string }} opts `path` repo-relative; `head` defaults to HEAD
 * @returns {Promise<{ ok: boolean, problem?: string }>}
 */
export async function verifyLedger({ repoRoot, path: file, base, head = 'HEAD' }) {
  const headSha = await resolveCommit(repoRoot, head);
  const baseSha = await mergeBase(repoRoot, await resolveCommit(repoRoot, base), headSha);
  const before = await readAt(repoRoot, baseSha, file);
  if (before === null) return { ok: true };
  const after = await readAt(repoRoot, headSha, file);
  if (after === null) return { ok: false, problem: `${file} exists on base ${baseSha.slice(0, 12)} but is missing (deleted) on head` };
  if (after.startsWith(before)) return { ok: true };
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.at(-1) === '') a.pop();
  for (let i = 0; i < a.length; i++) {
    const n = i + 1;
    if (i >= b.length || (b[i] === '' && i === b.length - 1)) return { ok: false, problem: `${file}: line ${n} was removed (base had ${a.length} line(s))` };
    if (a[i] !== b[i]) return { ok: false, problem: `${file}: line ${n} was changed; ledger lines are append-only` };
  }
  // Every base line matches but bytes differ: base's last line had no newline and head extended it.
  return { ok: false, problem: `${file}: line ${a.length} was changed; ledger lines are append-only` };
}
