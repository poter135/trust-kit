#!/usr/bin/env node
// trust-kit CLI: `trust-kit <subcommand> [--flags]`.
import { loadConfig, TrustConfigError } from '../src/config.mjs';

/** @type {Record<string, { desc: string, run: (flags: Record<string, string|boolean>) => number }>} */
const SUBCOMMANDS = {
  config: {
    desc: 'validate trust.config.json and print the resolved config (--root <dir>, default cwd)',
    run(flags) {
      const root = typeof flags.root === 'string' ? flags.root : process.cwd();
      console.log(JSON.stringify(loadConfig(root), null, 2));
      return 0;
    },
  },
};

/** @param {string[]} args */
function parseFlags(args) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    if (v !== undefined) flags[k] = v;
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[k] = args[++i];
    else flags[k] = true;
  }
  return flags;
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
  process.exit(SUBCOMMANDS[sub].run(parseFlags(rest)));
} catch (e) {
  if (e instanceof TrustConfigError) { console.error(e.message); process.exit(1); }
  throw e;
}
