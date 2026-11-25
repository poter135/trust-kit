// R25: no absolute local path (home dir, temp dir, repo root) may reach evidence, packet or approval output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, commit, writeFiles, nodeTestConfig } from './redgreen/helpers.mjs';
import { buildEvidence } from '../src/evidence.mjs';
import { recordApproval } from '../src/approval.mjs';
import { displayPath } from '../src/paths.mjs';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trust-kit.mjs');
const TMP = os.tmpdir();
const TMP_REAL = fs.realpathSync(TMP);

/** Fails if `text` contains any absolute local path marker. */
function assertNoAbsPath(text, repoRoot, label) {
  for (const bad of ['/Users/', '/private/', '/home/', TMP, TMP_REAL, repoRoot]) {
    assert.ok(!text.includes(bad), `${label} contains "${bad}":\n${text}`);
  }
}

function setup() {
  const dir = makeRepo();
  const sha = commit(dir, {
    'trust.config.json': nodeTestConfig(),
    '.trust/items/web1.json': JSON.stringify({ id: 'web1', title: 'Web fix', surfaces: ['web'], acceptance: ['ok'], approvals: [{ kind: 'hosting', target: 'site' }] }),
  });
  return { dir, sha };
}
const outsideDir = () => fs.mkdtempSync(path.join(TMP, 'tk-outside-'));

test('displayPath: inside → repo-relative posix; outside → <outside-repo>/<basename>', () => {
  const { dir } = setup();
  assert.equal(displayPath(dir, path.join(dir, 'a', 'b.json')), 'a/b.json');
  assert.equal(displayPath(dir, 'a/b.json'), 'a/b.json');
  assert.equal(displayPath(dir, dir), '.');
  const out = outsideDir();
  assert.equal(displayPath(dir, path.join(out, 'rg.json')), '<outside-repo>/rg.json');
  // macOS: /var/... and /private/var/... are the same place; a non-realpath'd inside path is still inside.
  if (dir.startsWith('/private/')) assert.equal(displayPath(dir, path.join(dir.slice('/private'.length), 'x.json')), 'x.json');
});

test('evidence: missing red-green + missing screens, inside repo → no absolute path in bundle', async () => {
  const { dir, sha } = setup();
  const b = await buildEvidence({ repoRoot: dir, itemId: 'web1', commit: sha, redGreenPath: path.join(dir, 'out/none.json'), screensDir: path.join(dir, 'shots') });
  assert.equal(b.complete, false);
  const s = JSON.stringify(b);
  assertNoAbsPath(s, dir, 'bundle');
  assert.ok(s.includes('out/none.json') && s.includes('shots'), s);
});

test('evidence: red-green and screens outside repo → shown as <outside-repo>/<name>', async () => {
  const { dir, sha } = setup();
  const out = outsideDir();
  writeFiles(out, { 'shots/a.png': 'x' });
  const b = await buildEvidence({ repoRoot: dir, itemId: 'web1', commit: sha, redGreenPath: path.join(out, 'rg.json'), screensDir: path.join(out, 'shots') });
  fs.writeFileSync(path.join(out, 'shots/a.png'), 'changed-without-manifest');
  const s = JSON.stringify(b);
  assertNoAbsPath(s, dir, 'bundle');
  assert.ok(s.includes('<outside-repo>/rg.json') && s.includes('<outside-repo>/shots'), s);
});

test('approval: unknown packet error message has no absolute path', () => {
  const { dir } = setup();
  assert.throws(() => recordApproval({ repoRoot: dir, packetId: 'abcdef123456', numbers: [1] }), (e) => {
    assertNoAbsPath(e.message, dir, 'approval error');
    return e.message.includes('.trust/packets/abcdef123456.json');
  });
});

test('CLI: evidence + screens collect + packet with inside and outside paths → no absolute path in files or stderr', () => {
  const { dir, sha } = setup();
  const out = outsideDir();
  writeFiles(out, { 'rg.json': JSON.stringify({ schema: 'trust-kit/red-green@1', head: sha, verdict: 'no_red', runners: [], newlyEnforced: [] }) });
  writeFiles(dir, { 'shots/a.png': 'x' });
  const run = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });

  const sc = run(['screens', 'collect', '--dir', 'shots', '--commit', sha]);
  assert.equal(sc.status, 0, sc.stderr);
  assertNoAbsPath(sc.stderr, dir, 'screens collect stderr');

  const ev = run(['evidence', '--item', 'web1', '--red-green', path.join(out, 'rg.json'), '--screens', path.join(out, 'noshots')]);
  assert.equal(ev.status, 1, ev.stderr);
  assertNoAbsPath(ev.stderr, dir, 'evidence stderr');
  assertNoAbsPath(fs.readFileSync(path.join(dir, '.trust/evidence/web1.json'), 'utf8'), dir, 'evidence json');

  const ev2 = run(['evidence', '--item', 'web1', '--red-green', path.join(out, 'rg.json'), '--screens', 'shots', '--out', path.join(out, 'ev.json')]);
  assertNoAbsPath(ev2.stderr, dir, 'evidence stderr (outside --out)');
  assertNoAbsPath(fs.readFileSync(path.join(out, 'ev.json'), 'utf8'), dir, 'evidence json (outside --out)');

  const pk = run(['packet', '--items', 'web1', '--base', sha, '--out', path.join(out, 'packet.md')]);
  assert.equal(pk.status, 0, pk.stderr);
  assertNoAbsPath(pk.stderr + pk.stdout, dir, 'packet output');
  assertNoAbsPath(fs.readFileSync(path.join(out, 'packet.md'), 'utf8'), dir, 'packet md');
  assertNoAbsPath(fs.readFileSync(path.join(out, 'packet.md.json'), 'utf8'), dir, 'packet json');
  for (const f of fs.readdirSync(path.join(dir, '.trust/packets'))) {
    assertNoAbsPath(fs.readFileSync(path.join(dir, '.trust/packets', f), 'utf8'), dir, `packet record ${f}`);
  }
});

test('packet: legacy evidence bundle with repo-root paths in missing is scrubbed', () => {
  const { dir, sha } = setup();
  writeFiles(dir, { '.trust/evidence/web1.json': JSON.stringify({ schema: 'trust-kit/evidence@1', commit: sha,
    redGreen: { verdict: 'valid_red', ciRunUrl: 'https://ci.example/1', head: sha }, checks: [], complete: false,
    missing: [`讀不到紅綠燈報告 ${path.join(dir, 'out/rg.json')}`] }) });
  const r = spawnSync(process.execPath, [bin, 'packet', '--items', 'web1', '--base', sha, '--out', 'p.md'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(dir, 'p.md'), 'utf8');
  assertNoAbsPath(md + fs.readFileSync(path.join(dir, 'p.md.json'), 'utf8'), dir, 'packet');
  assert.ok(md.includes('out/rg.json'), md);
});
