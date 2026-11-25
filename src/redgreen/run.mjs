// Runs the changed tests on base (with head's test files copied in) and on head, then judges them.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { getRunner } from '../runners/index.mjs';
import { mergeBase, resolveCommit, showFile, withWorktree } from '../git.mjs';
import { listChangedTests } from './changed-tests.mjs';
import { judgeRedGreen, combineVerdicts } from './judge.mjs';

/**
 * @typedef {import('./judge.mjs').Verdict} Verdict
 * @typedef {{ schema: 'trust-kit/red-green@1', base: string, requestedBase: string, head: string, verdict: Verdict,
 *   runners: { id: string, tests: import('./judge.mjs').JudgedTest[] }[], generatedAt: string, ciRunUrl?: string }} RedGreenReport
 *   `base` is the merge-base of the requested base and head (what was diffed and checked out);
 *   `requestedBase` is the resolved SHA the caller passed.
 */

const tail = (s, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);

/**
 * Runs one setup command (no shell). Failure throws, naming runner, side, command and the stderr tail.
 * @param {string[]} argv @param {string} cwd @param {string} runnerId @param {'base'|'head'} side
 */
function runSetup(argv, cwd, runnerId, side) {
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  return new Promise((resolve, reject) => {
    execFile(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) { resolve(undefined); return; }
      const how = typeof err.code === 'number' ? `exit ${err.code}` : (err.code ?? err.message);
      reject(new Error(`setup failed for runner "${runnerId}" on the ${side} checkout: ${JSON.stringify(argv)} (${how}): `
        + tail(String(stderr || err.message).trim())));
    });
  });
}

/**
 * @param {import('../config.mjs').TrustConfig} config
 * @param {{ runnerId: string, file: string }[]} changed @param {string} root checkout root
 * @param {'base'|'head'} side
 * @returns {Promise<Map<string, import('../runners/index.mjs').TestResult[]>>} results per runner id
 */
async function runChanged(config, changed, root, side) {
  const out = new Map();
  for (const rc of config.runners) {
    const files = changed.filter((c) => c.runnerId === rc.id).map((c) => c.file);
    if (files.length === 0) continue;
    const cwd = path.join(root, rc.cwd);
    for (const argv of rc.setup ?? []) await runSetup(argv, cwd, rc.id, side);
    const opts = { cwd, repoRoot: root, files };
    if (rc.command) opts.command = rc.command;
    out.set(rc.id, await getRunner(rc.adapter).run(opts));
  }
  return out;
}

/** GitHub Actions run URL when running there; undefined elsewhere. */
function ciRunUrl() {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = process.env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : undefined;
}

/**
 * The effective base is `git merge-base <base> <head>`, so changes the base branch made after the fork never
 * count as the change under test. Config and test files come from the head commit; both sides run in temporary worktrees, so the caller's
 * working tree (including uncommitted changes) never affects the report.
 * @param {{ repoRoot: string, base: string, head: string }} opts revs may be any commit-ish
 * @returns {Promise<RedGreenReport>}
 */
export async function runRedGreen({ repoRoot, base, head }) {
  const requestedBase = await resolveCommit(repoRoot, base);
  const headSha = await resolveCommit(repoRoot, head);
  const baseSha = await mergeBase(repoRoot, requestedBase, headSha);

  const { config, changed, headResults } = await withWorktree(repoRoot, headSha, async (dir) => {
    const cfg = loadConfig(dir);
    const ch = await listChangedTests({ repoRoot, base: baseSha, head: headSha, config: cfg });
    return { config: cfg, changed: ch, headResults: await runChanged(cfg, ch, dir, 'head') };
  });

  const baseResults = changed.length === 0 ? new Map() : await withWorktree(repoRoot, baseSha, async (dir) => {
    for (const file of new Set(changed.map((c) => c.file))) {
      const dest = path.join(dir, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, await showFile(repoRoot, headSha, file));
    }
    return runChanged(config, changed, dir, 'base');
  });

  const runners = [];
  const verdicts = [];
  for (const rc of config.runners) {
    const mine = changed.filter((c) => c.runnerId === rc.id);
    if (mine.length === 0) continue;
    const j = judgeRedGreen({ changed: mine, baseResults: baseResults.get(rc.id) ?? [], headResults: headResults.get(rc.id) ?? [] });
    runners.push({ id: rc.id, tests: j.tests });
    verdicts.push(j.verdict);
  }

  /** @type {RedGreenReport} */
  const report = {
    schema: 'trust-kit/red-green@1', base: baseSha, requestedBase, head: headSha, verdict: combineVerdicts(verdicts),
    runners, generatedAt: new Date().toISOString(),
  };
  const url = ciRunUrl();
  if (url) report.ciRunUrl = url;
  return report;
}
