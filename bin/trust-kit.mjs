#!/usr/bin/env node
// trust-kit CLI: `trust-kit <subcommand> [--flags]`.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, TrustConfigError } from '../src/config.mjs';
import { repoTopLevel } from '../src/git.mjs';
import { runRedGreen } from '../src/redgreen/run.mjs';
import { verifyRules, rulesReport, RulesError } from '../src/rules.mjs';
import { detectProtectedChanges } from '../src/protected.mjs';
import { verifyLedger } from '../src/ledger.mjs';
import { collectScreens } from '../src/screens.mjs';
import { buildEvidence } from '../src/evidence.mjs';
import { ItemError, loadItem, assertItemId } from '../src/items.mjs';
import { buildPacket, writePacket } from '../src/packet.mjs';
import { recordApproval, checkApproval, ApprovalError } from '../src/approval.mjs';
import { resolveCommit } from '../src/git.mjs';

/** Thrown for bad CLI input; printed without a stack, exit 1 (or `exitCode`). */
class UsageError extends Error {
  /** @param {string} msg @param {number} [exitCode] */
  constructor(msg, exitCode = 1) { super(msg); this.exitCode = exitCode; }
}

/** @type {Record<string, { desc: string, run: (flags: Record<string, string|boolean>, positional: string[]) => number|Promise<number> }>} */
const SUBCOMMANDS = {
  config: {
    desc: 'validate trust.config.json and print the resolved config (--root <dir>, default cwd)',
    run(flags) {
      const root = typeof flags.root === 'string' ? flags.root : process.cwd();
      console.log(JSON.stringify(loadConfig(root), null, 2));
      return 0;
    },
  },
  'red-green': {
    desc: 'prove changed tests fail on base by behavior and pass on head (--base <rev> --head <rev> [--out <path>]); exit 1 only on head_fail or error',
    async run(flags) {
      for (const f of ['base', 'head']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`red-green: missing --${f} <rev>`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      const report = await runRedGreen({ repoRoot, base: /** @type {string} */ (flags.base), head: /** @type {string} */ (flags.head) });
      const json = `${JSON.stringify(report, null, 2)}\n`;
      if (typeof flags.out === 'string') {
        fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        fs.writeFileSync(flags.out, json);
      } else {
        process.stdout.write(json);
      }
      const n = report.runners.reduce((a, r) => a + r.tests.length, 0);
      console.error(`red-green: ${report.verdict} (${n} test result(s), base ${report.base.slice(0, 12)}, head ${report.head.slice(0, 12)})`);
      for (const p of report.ruleProblems ?? []) console.error(`  rule ${p.ruleId}: ${p.problem}`);
      return report.verdict === 'head_fail' ? 1 : 0;
    },
  },
  rules: {
    desc: 'rules registry (.trust/rules.json): `rules verify` checks every enforced rule (exit 1 on problems); `rules report` prints a markdown table (--root <dir>, default cwd)',
    run(flags, positional) {
      const root = typeof flags.root === 'string' ? flags.root : process.cwd();
      const [action] = positional;
      if (action === 'verify') {
        const { ok, problems } = verifyRules({ repoRoot: root });
        for (const p of problems) console.error(`✗ ${p.problem}\n  修正：${p.fix}`);
        console.error(ok ? 'rules verify: ok' : `rules verify: ${problems.length} problem(s)`);
        return ok ? 0 : 1;
      }
      if (action === 'report') { process.stdout.write(rulesReport({ repoRoot: root })); return 0; }
      throw new UsageError(`rules: ${action ? `unknown action "${action}"` : 'missing action'}; use \`rules verify\` or \`rules report\``, 2);
    },
  },
  protected: {
    desc: 'list changed protected paths, one per line (--base <rev> --head <rev>; diffs from their merge-base; exit 0)',
    async run(flags) {
      for (const f of ['base', 'head']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`protected: missing --${f} <rev>`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      const paths = await detectProtectedChanges({ repoRoot, base: /** @type {string} */ (flags.base), head: /** @type {string} */ (flags.head) });
      for (const p of paths) console.log(p);
      return 0;
    },
  },
  ledger: {
    desc: '`ledger verify --base <rev> [--head <rev>] [--path <file>]`: the ledger must only be appended to since merge-base (exit 1 otherwise); path defaults to config ledger.path',
    async run(flags, positional) {
      const [action] = positional;
      if (action !== 'verify') throw new UsageError(`ledger: ${action ? `unknown action "${action}"` : 'missing action'}; use \`ledger verify\``, 2);
      if (typeof flags.base !== 'string') throw new UsageError('ledger verify: missing --base <rev>');
      const repoRoot = await repoTopLevel(process.cwd());
      const file = typeof flags.path === 'string' ? flags.path : loadConfig(repoRoot).ledger.path;
      const res = await verifyLedger({ repoRoot, path: file, base: flags.base, ...(typeof flags.head === 'string' ? { head: flags.head } : {}) });
      console.error(res.ok ? 'ledger verify: ok' : `ledger verify: ${res.problem}`);
      return res.ok ? 0 : 1;
    },
  },
  screens: {
    desc: '`screens collect --dir <d> --commit <sha>`: hash screenshots/recordings (.png .jpg .jpeg .webp .mp4 .mov) into <d>/manifest.json',
    async run(flags, positional) {
      const [action] = positional;
      if (action !== 'collect') throw new UsageError(`screens: ${action ? `unknown action "${action}"` : 'missing action'}; use \`screens collect\``, 2);
      for (const f of ['dir', 'commit']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`screens collect: missing --${f}`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      const commit = await resolveCommit(repoRoot, /** @type {string} */ (flags.commit));
      const dir = path.resolve(/** @type {string} */ (flags.dir));
      const m = collectScreens({ dir, commit });
      console.error(`screens collect: ${m.files.length} file(s) for ${commit.slice(0, 12)} → ${path.join(dir, 'manifest.json')}`);
      return 0;
    },
  },
  evidence: {
    desc: 'build the evidence bundle (--item <id> --red-green <path> [--screens <dir>] [--out <path>], out defaults to <evidence.outDir>/<item>.json, commit = HEAD); exit 1 and list each gap when incomplete',
    async run(flags) {
      for (const f of ['item', 'red-green']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`evidence: missing --${f}`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      const itemId = /** @type {string} */ (flags.item);
      const opts = { repoRoot, itemId, commit: typeof flags.commit === 'string' ? flags.commit : 'HEAD',
        redGreenPath: path.resolve(/** @type {string} */ (flags['red-green'])) };
      if (typeof flags.screens === 'string') opts.screensDir = path.resolve(flags.screens);
      const bundle = await buildEvidence(opts);
      const out = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(repoRoot, loadConfig(repoRoot).evidence.outDir, `${itemId}.json`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
      if (bundle.complete) { console.error(`evidence: complete (${bundle.commit.slice(0, 12)}) → ${out}`); return 0; }
      for (const m of bundle.missing) console.error(`✗ ${m}`);
      console.error(`evidence: incomplete, ${bundle.missing.length} gap(s) → ${out}`);
      return 1;
    },
  },
  packet: {
    desc: 'build the review packet (--items B1,B2 --base <rev> [--head <rev>, default HEAD] --out <md>); also writes <md>.json and .trust/packets/<id>.json; prints the packet id',
    async run(flags) {
      for (const f of ['items', 'base', 'out']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`packet: missing --${f}`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      const head = await resolveCommit(repoRoot, typeof flags.head === 'string' ? flags.head : 'HEAD');
      const outDir = loadConfig(repoRoot).evidence.outDir;
      const ids = /** @type {string} */ (flags.items).split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) throw new UsageError('packet: --items is empty');
      const items = ids.map((id) => {
        assertItemId(id);
        const item = loadItem(repoRoot, id);
        const file = path.join(repoRoot, outDir, `${id}.json`);
        let evidence = null;
        try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { evidence = null; }
        return { item, evidence };
      });
      const protectedChanges = await detectProtectedChanges({ repoRoot, base: /** @type {string} */ (flags.base), head });
      const packet = buildPacket({ repoRoot, head, items, protectedChanges });
      const out = path.resolve(/** @type {string} */ (flags.out));
      writePacket({ repoRoot, packet, head, out });
      const flagged = packet.entries.filter((e) => e.flagged.length > 0).length;
      console.log(packet.id);
      console.error(`packet ${packet.id}: ${packet.entries.length} entr(ies), ${flagged} flagged, head ${head.slice(0, 12)} → ${out}`);
      return 0;
    },
  },
  approve: {
    desc: 'record the user\'s chat approval of packet entries (--packet <id> --numbers 1,3 [--allow-flagged]) into .trust/approvals/<id>.json',
    async run(flags) {
      for (const f of ['packet', 'numbers']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`approve: missing --${f}`);
      }
      const numbers = /** @type {string} */ (flags.numbers).split(',').map((s) => s.trim());
      if (!numbers.every((s) => /^[1-9]\d*$/.test(s))) throw new UsageError(`approve: --numbers must be positive integers, e.g. 1,3`);
      const repoRoot = await repoTopLevel(process.cwd());
      const rec = recordApproval({ repoRoot, packetId: /** @type {string} */ (flags.packet), numbers: numbers.map(Number), allowFlagged: flags['allow-flagged'] === true });
      console.error(`approve: packet ${rec.packetId}, approved ${rec.entries.map((e) => e.n).join(',')} (head ${String(rec.head).slice(0, 12)})`);
      return 0;
    },
  },
  'check-approval': {
    desc: 'exit 0 only if an approval record covers --kind <k> --target <t> --commit <sha> exactly; exit 1 with the reason otherwise',
    async run(flags) {
      for (const f of ['kind', 'target', 'commit']) {
        if (typeof flags[f] !== 'string') throw new UsageError(`check-approval: missing --${f}`);
      }
      const repoRoot = await repoTopLevel(process.cwd());
      let commit = /** @type {string} */ (flags.commit);
      if (flags.kind !== 'batch-write' && !/^[0-9a-f]{40}$/.test(commit)) commit = await resolveCommit(repoRoot, commit);
      const res = checkApproval({ repoRoot, kind: /** @type {string} */ (flags.kind), target: /** @type {string} */ (flags.target), commit });
      console.error(res.ok ? `check-approval: ok (${flags.kind}/${flags.target}/${commit})` : `check-approval: ${res.reason}`);
      return res.ok ? 0 : 1;
    },
  },
};

/** @param {string[]} args @returns {{ flags: Record<string, string|boolean>, positional: string[] }} */
function parseArgs(args) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[k] = args[++i];
    else flags[k] = true;
  }
  return { flags, positional };
}

function usage() {
  return ['Usage: trust-kit <subcommand> [--flags]', 'Subcommands:',
    ...Object.entries(SUBCOMMANDS).map(([n, s]) => `  ${n}  ${s.desc}`)].join('\n');
}

const [sub, ...rest] = process.argv.slice(2);
if (!sub || !Object.hasOwn(SUBCOMMANDS, sub)) {
  console.error(`${sub ? `Unknown subcommand: ${sub}` : 'Missing subcommand'}\n${usage()}`);
  process.exit(2);
}
try {
  const { flags, positional } = parseArgs(rest);
  process.exitCode = await SUBCOMMANDS[sub].run(flags, positional);
} catch (e) {
  if (e instanceof UsageError) { console.error(e.message); process.exit(e.exitCode); }
  if (e instanceof TrustConfigError || e instanceof RulesError || e instanceof ItemError || e instanceof ApprovalError) { console.error(e.message); process.exit(1); }
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
