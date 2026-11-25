// Screen evidence: hashes screenshots / recordings in a directory into `<dir>/manifest.json`.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MANIFEST = 'manifest.json';
export const MEDIA_EXTS = Object.freeze(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov']);

/** @typedef {{ commit: string, files: { path: string, sha256: string }[] }} ScreensManifest */

/** @param {string} dir @returns {string[]} absolute file paths */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

/**
 * @param {{ dir: string, commit: string }} opts
 * @returns {ScreensManifest} also written to `<dir>/manifest.json`; paths are dir-relative with "/" separators
 */
export function collectScreens({ dir, commit }) {
  const files = walk(dir)
    .map((abs) => ({ abs, rel: path.relative(dir, abs).split(path.sep).join('/') }))
    .filter(({ rel }) => rel !== MANIFEST && MEDIA_EXTS.includes(path.extname(rel).toLowerCase()))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map(({ abs, rel }) => ({ path: rel, sha256: createHash('sha256').update(fs.readFileSync(abs)).digest('hex') }));
  /** @type {ScreensManifest} */
  const manifest = { commit, files };
  fs.writeFileSync(path.join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** @param {string} dir @returns {ScreensManifest|undefined} undefined when there is no readable manifest */
export function readScreens(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    if (m && typeof m.commit === 'string' && Array.isArray(m.files)) return m;
  } catch { /* missing or invalid */ }
  return undefined;
}
