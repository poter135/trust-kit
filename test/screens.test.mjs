import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { collectScreens } from '../src/screens.mjs';

const SHA = 'a'.repeat(40);
const tmpDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-screens-')));

test('collectScreens returns a stable sha256 for the same image and writes manifest.json', () => {
  const dir = tmpDir();
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  fs.writeFileSync(path.join(dir, 'home.png'), bytes);
  const a = collectScreens({ dir, commit: SHA });
  const b = collectScreens({ dir, commit: SHA });
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(a, { commit: SHA, files: [{ path: 'home.png', sha256: expected }] });
  assert.deepEqual(b, a);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')), a);
});

test('collectScreens ignores manifest.json and non-media files and sorts by path, recursing', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'b.jpg'), 'b');
  fs.writeFileSync(path.join(dir, 'a.webp'), 'a');
  fs.writeFileSync(path.join(dir, 'sub', 'c.mp4'), 'c');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  const m = collectScreens({ dir, commit: SHA });
  assert.deepEqual(m.files.map((f) => f.path), ['a.webp', 'b.jpg', 'sub/c.mp4']);
});
