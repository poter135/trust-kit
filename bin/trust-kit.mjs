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
  if (e instanceof TrustConfigError || e instanceof RulesError) { console.error(e.message); process.exit(1); }
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
}
