// trust-kit's own first layer: the core must not depend on adapter files or on any project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED = ['Vwake', 'vwake', 'functions/src', 'lib/features'];
const MSG = '核心不得依賴轉接層／專案';
const IMPORT_RE = /(?:\bimport\s*(?:[^'"()]*?\bfrom\s*)?|\bexport\s+[^'"]*?\bfrom\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** @param {string} root repo root containing src/ */
export function findViolations(root) {
  const srcDir = path.join(root, 'src');
  const runnersDir = path.join(srcDir, 'runners');
  const runnersIndex = path.join(runnersDir, 'index.mjs');
  const out = [];
  for (const file of walk(srcDir)) {
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    const inRunners = file.startsWith(runnersDir + path.sep);
    text.split('\n').forEach((line, i) => {
      for (const s of BANNED) {
        if (line.includes(s)) out.push(`${rel}:${i + 1}: contains "${s}" — ${MSG}`);
      }
    });
    if (!file.endsWith('.mjs') || inRunners) continue;
    // Match over the whole text so multi-line import/export-from statements are caught.
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if ((target === runnersDir || target.startsWith(runnersDir + path.sep)) && target !== runnersIndex) {
        const lineNo = text.slice(0, m.index).split('\n').length;
        out.push(`${rel}:${lineNo}: imports "${spec}" (only src/runners/index.mjs allowed) — ${MSG}`);
      }
    }
  }
  return out;
}

test('src/ respects core boundaries', () => {
  const v = findViolations(repoRoot);
  assert.deepEqual(v, [], v.join('\n'));
});

test('checker reports adapter imports and project strings with file and line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-bound-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src', 'runners'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'runners', 'index.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(tmp, 'src', 'runners', 'jest.mjs'), "import x from '../config.mjs';\n");
    fs.writeFileSync(path.join(tmp, 'src', 'ok.mjs'), "import { r } from './runners/index.mjs';\n");
    fs.writeFileSync(path.join(tmp, 'src', 'bad.mjs'),
      "// header\nimport { j } from './runners/jest.mjs';\nconst p = 'functions/src/x';\nconst m = await import('./runners/flutter.mjs');\n");
    fs.writeFileSync(path.join(tmp, 'src', 'multi.mjs'),
      "import {\n  a,\n  b,\n} from './runners/jest.mjs';\nexport {\n  c,\n} from \"./runners/flutter.mjs\";\n");
    const v = findViolations(tmp);
    assert.equal(v.length, 5, v.join('\n'));
    assert.ok(v.some((s) => s.startsWith(path.join('src', 'multi.mjs') + ':1:') && s.includes('./runners/jest.mjs')), v.join('\n'));
    assert.ok(v.some((s) => s.startsWith(path.join('src', 'multi.mjs') + ':5:') && s.includes('./runners/flutter.mjs')), v.join('\n'));
    assert.ok(v.some((s) => s.startsWith(path.join('src', 'bad.mjs') + ':2:') && s.includes(MSG)));
    assert.ok(v.some((s) => s.startsWith(path.join('src', 'bad.mjs') + ':3:') && s.includes('functions/src')));
    assert.ok(v.some((s) => s.startsWith(path.join('src', 'bad.mjs') + ':4:')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
