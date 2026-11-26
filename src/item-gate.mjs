// item-gate: a change that touches product paths must add or modify a work item, or add an exemption with a reason.
// The gate's config is read from the merge-base, never from the change itself, so a change cannot turn its own gate
// off or down to `warn`.
import path from 'node:path';
import picomatch from 'picomatch';
import { CONFIG_FILE, parseConfig } from './config.mjs';
import { diffNameStatus, mergeBase, resolveCommit, showFile } from './git.mjs';
import { ITEMS_DIR, ItemError, validateItem } from './items.mjs';

export const EXEMPTIONS_DIR = '.trust/exemptions';
/** Minimum exemption reason length (characters, trimmed): enough for one real sentence. */
export const MIN_REASON = 10;

/**
 * @typedef {'not_configured'|'no_product_change'|'item'|'exempt'|'missing'} GateVerdict
 * @typedef {{ schema: 'trust-kit/item-gate@1', base: string, head: string, mode: 'warn'|'enforce'|null, verdict: GateVerdict,
 *   productChanges: string[], items: string[], exemptions: { file: string, reason: string }[], problems: string[] }} GateReport
 *   `ok` for the caller: verdict is not `missing`, or mode is `warn`.
 */

/** @param {string} repoRoot @param {string} rev @param {string} file */
async function readJsonAt(repoRoot, rev, file) {
  return JSON.parse((await showFile(repoRoot, rev, file)).toString('utf8'));
}

/**
 * @param {{ repoRoot: string, base: string, head: string }} opts revs may be any commit-ish
 * @returns {Promise<GateReport>}
 */
export async function runItemGate({ repoRoot, base, head }) {
  const headSha = await resolveCommit(repoRoot, head);
  const baseSha = await mergeBase(repoRoot, await resolveCommit(repoRoot, base), headSha);
  const config = parseConfig((await showFile(repoRoot, baseSha, CONFIG_FILE)).toString('utf8'), `${baseSha.slice(0, 12)}:${CONFIG_FILE}`);
  /** @type {GateReport} */
  const report = { schema: 'trust-kit/item-gate@1', base: baseSha, head: headSha, mode: config.itemGate?.mode ?? null,
    verdict: 'not_configured', productChanges: [], items: [], exemptions: [], problems: [] };
  if (!config.itemGate) return report;

  const inProduct = picomatch(config.itemGate.productPaths, { dot: true });
  const ignored = config.itemGate.ignorePaths.length ? picomatch(config.itemGate.ignorePaths, { dot: true }) : () => false;
  const isProduct = (/** @type {string} */ p) => inProduct(p) && !ignored(p);
  const changes = await diffNameStatus(repoRoot, baseSha, headSha);
  report.productChanges = [...new Set(changes.map((c) => c.path).filter((p) => isProduct(p)))].sort();
  // Only files this change adds or modifies count; a deletion or a file already on base proves nothing about it.
  const touched = changes.filter((c) => c.status === 'A' || c.status === 'M').map((c) => c.path).sort();

  for (const p of touched.filter((f) => path.posix.dirname(f) === ITEMS_DIR && f.endsWith('.json'))) {
    const id = path.posix.basename(p, '.json');
    try {
      report.items.push(validateItem(await readJsonAt(repoRoot, headSha, p), id, p).id);
    } catch (e) {
      report.problems.push(e instanceof ItemError ? e.message : `${p}: invalid JSON (${e.message})`);
    }
  }
  for (const p of touched.filter((f) => path.posix.dirname(f) === EXEMPTIONS_DIR && f.endsWith('.json'))) {
    let raw;
    try { raw = await readJsonAt(repoRoot, headSha, p); } catch (e) { report.problems.push(`${p}: invalid JSON (${e.message})`); continue; }
    const reason = typeof raw?.reason === 'string' ? raw.reason.trim() : '';
    if ([...reason].length < MIN_REASON) {
      report.problems.push(`${p}: reason must be a sentence of at least ${MIN_REASON} characters explaining why no work item is needed`);
      continue;
    }
    report.exemptions.push({ file: p, reason });
  }

  if (report.productChanges.length === 0) report.verdict = 'no_product_change';
  else if (report.items.length > 0) report.verdict = 'item';
  else if (report.exemptions.length > 0) report.verdict = 'exempt';
  else report.verdict = 'missing';
  return report;
}

/** @param {GateReport} r */
export const gateOk = (r) => r.verdict !== 'missing' || r.mode === 'warn';
