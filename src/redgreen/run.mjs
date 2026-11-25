// Runs the changed tests on base (with head's test files copied in) and on head, then judges them.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { getRunner } from '../runners/index.mjs';
import { resolveCommit, showFile, withWorktree } from '../git.mjs';
import { listChangedTests } from './changed-tests.mjs';
import { judgeRedGreen, combineVerdicts } from './judge.mjs';

/**
 * @typedef {import('./judge.mjs').Verdict} Verdict
 * @typedef {{ schema: 'trust-kit/red-green@1', base: string, head: string, verdict: Verdict,
 *   runners: { id: string, tests: import('./judge.mjs').JudgedTest[] }[], generatedAt: string, ciRunUrl?: string }} RedGreenReport
 */

/**
 * @param {import('../config.mjs').TrustConfig} config
 * @param {{ runnerId: string, file: string }[]} changed @param {string} root checkout root
 * @returns {Promise<Map<string, import('../runners/index.mjs').TestResult[]>>} results per runner id
 */
async function runChanged(config, changed, root) {
  const out = new Map();
  for (const rc of config.runners) {
    const files = changed.filter((c) => c.runnerId === rc.id).map((c) => c.file);
    if (files.length === 0) continue;
    const opts = { cwd: path.join(root, rc.cwd), repoRoot: root, files };
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
 * Config and test files come from the head commit; both sides run in temporary worktrees, so the caller's
 * working tree (including uncommitted changes) never affects the report.
 * @param {{ repoRoot: string, base: string, head: string }} opts revs may be any commit-ish
 * @returns {Promise<RedGreenReport>}
 */
export async function runRedGreen({ repoRoot, base, head }) {
  const baseSha = await resolveCommit(repoRoot, base);
  const headSha = await resolveCommit(repoRoot, head);

  const { config, changed, headResults } = await withWorktree(repoRoot, headSha, async (dir) => {
    const cfg = loadConfig(dir);
    const ch = await listChangedTests({ repoRoot, base: baseSha, head: headSha, config: cfg });
    return { config: cfg, changed: ch, headResults: await runChanged(cfg, ch, dir) };
  });

  const baseResults = changed.length === 0 ? new Map() : await withWorktree(repoRoot, baseSha, async (dir) => {
    for (const file of new Set(changed.map((c) => c.file))) {
      const dest = path.join(dir, file);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, await showFile(repoRoot, headSha, file));
    }
    return runChanged(config, changed, dir);
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
    schema: 'trust-kit/red-green@1', base: baseSha, head: headSha, verdict: combineVerdicts(verdicts),
    runners, generatedAt: new Date().toISOString(),
  };
  const url = ciRunUrl();
  if (url) report.ciRunUrl = url;
  return report;
}
