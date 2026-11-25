// Detects changes to the verification system itself: configured protected paths, trust-kit's own files, and the
// check files of rules that were enforced on the base.
import path from 'node:path';
import picomatch from 'picomatch';
import { ALWAYS_PROTECTED, CONFIG_FILE, parseConfig } from './config.mjs';
import { diffNameStatus, mergeBase, resolveCommit, showFile } from './git.mjs';
import { RULES_FILE, loadRulesAt } from './rules.mjs';

/** Config as committed at `rev`. @param {string} repoRoot @param {string} rev @returns {Promise<import('./config.mjs').TrustConfig>} */
export async function loadConfigAt(repoRoot, rev) {
  return parseConfig((await showFile(repoRoot, rev, CONFIG_FILE)).toString('utf8'), `${rev.slice(0, 12)}:${CONFIG_FILE}`);
}

/**
 * Changed paths (merge-base(base, head) → head) that are protected: anything matching `config.protectedPaths`
 * (plus trust-kit's always-protected files), and the `check.file` of every rule enforced in the merge-base's rules
 * file — so deleting a rule together with its check is still reported. Renames count under both names.
 * A rule going enforced → not enforced (or disappearing) reports the rules file.
 * @param {{ repoRoot: string, base: string, head: string, config?: import('./config.mjs').TrustConfig }} opts
 *   `config` defaults to the head commit's trust.config.json.
 * @returns {Promise<string[]>} sorted, deduplicated repo-relative paths
 */
export async function detectProtectedChanges({ repoRoot, base, head, config }) {
  const headSha = await resolveCommit(repoRoot, head);
  const baseSha = await mergeBase(repoRoot, await resolveCommit(repoRoot, base), headSha);
  const cfg = config ?? await loadConfigAt(repoRoot, headSha);
  const baseRules = await loadRulesAt(repoRoot, baseSha);
  const enforced = baseRules.rules.filter((r) => r.status === 'enforced');
  const checkFiles = new Set(enforced.filter((r) => r.check).map((r) => path.posix.normalize(r.check.file)));
  const isProtected = picomatch([...new Set([...ALWAYS_PROTECTED, ...cfg.protectedPaths])], { dot: true });

  const out = new Set();
  for (const { path: p } of await diffNameStatus(repoRoot, baseSha, headSha)) {
    if (isProtected(p) || checkFiles.has(p)) out.add(p);
  }
  if (enforced.length > 0) {
    let headEnforced;
    try {
      headEnforced = new Set((await loadRulesAt(repoRoot, headSha)).rules.filter((r) => r.status === 'enforced').map((r) => r.id));
    } catch {
      headEnforced = new Set(); // unreadable head rules file: treat every rule as no longer enforced
    }
    if (enforced.some((r) => !headEnforced.has(r.id))) out.add(RULES_FILE);
  }
  return [...out].sort();
}
