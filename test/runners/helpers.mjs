// Shared helpers for runner adapter tests (not a test file itself).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixtures = path.join(repoRoot, 'test', 'fixtures', 'runners');

/** @param {string} file */
export const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n');

/** Drop `message` and sort, so assertions compare only classification. */
export const brief = (results) => results
  .map(({ file, name, status }) => ({ file, name, status }))
  .sort((a, b) => (a.file + a.name).localeCompare(b.file + b.name));
