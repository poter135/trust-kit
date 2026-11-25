// Paths shown to people or written into evidence/packet/approval output: never absolute, never a local username.
import fs from 'node:fs';
import path from 'node:path';

export const OUTSIDE_REPO = '<outside-repo>';

/** realpath of `p`, or of its nearest existing ancestor with the rest re-appended. @param {string} p */
function realish(p) {
  let cur = p;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there yet */ }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/** @param {string} root @param {string} abs @returns {string|null} posix relative path, or null when outside */
function relInside(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Display form of a path: relative to repoRoot with "/" separators, or `<outside-repo>/<basename>` when outside.
 * Symlinked spellings of the same place (e.g. macOS /var vs /private/var) count as inside.
 * @param {string} repoRoot @param {string} p absolute, or relative to repoRoot
 * @returns {string}
 */
export function displayPath(repoRoot, p) {
  const abs = path.resolve(repoRoot, p);
  const root = path.resolve(repoRoot);
  const direct = relInside(root, abs) ?? relInside(realish(root), realish(abs));
  return direct ?? `${OUTSIDE_REPO}/${path.basename(abs)}`;
}

/**
 * Rewrites any absolute path under repoRoot (either spelling) found inside free text to its repo-relative form.
 * For text produced elsewhere (e.g. evidence bundles written by older versions) before it is re-emitted.
 * @param {string} repoRoot @param {string} text
 */
export function scrubRepoRoot(repoRoot, text) {
  let out = String(text);
  const roots = [...new Set([path.resolve(repoRoot), realish(path.resolve(repoRoot))])].sort((a, b) => b.length - a.length);
  for (const r of roots) out = out.split(`${r}${path.sep}`).join('').split(r).join('.');
  return out;
}
