// GitHub Actions lookups through the `gh` CLI (execFile, no shell). Evidence uses this to accept only red-green
// reports that a GitHub Actions run of the same repository produced for the same commit.
import { execFile } from 'node:child_process';
import { git } from './git.mjs';

/** Name of the artifact the red-green workflow uploads. */
export const RED_GREEN_ARTIFACT = 'trust-red-green';

/**
 * @typedef {{ id: number, html_url: string, head_sha: string, status: string, conclusion: string|null, event: string,
 *   repository?: { full_name?: string } }} WorkflowRun
 * @typedef {{ name: string, status: string, conclusion: string|null }} WorkflowJob
 * @typedef {{ getRun(slug: string, runId: string): Promise<WorkflowRun>, getJobs(slug: string, runId: string): Promise<WorkflowJob[]>,
 *   downloadRedGreen(slug: string, runId: string, destDir: string): Promise<void> }} GithubClient
 */

/**
 * `owner/repo` of a GitHub remote URL (https, ssh or scp-like), or null when the URL is not on github.com.
 * @param {string} url
 */
export function parseGithubSlug(url) {
  const m = String(url).trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m && validParts(m[1], m[2]) ? `${m[1]}/${m[2]}` : null;
}

/** Owner and repo must not be made only of dots ("." / ".." would walk the API path). */
const validParts = (...parts) => parts.every((p) => !/^\.+$/.test(p));

/**
 * `owner/repo` of the repo's `origin` remote. Throws when there is no origin or it is not on github.com.
 * @param {string} repoRoot
 */
export async function originSlug(repoRoot) {
  let url;
  try {
    url = (await git(repoRoot, ['remote', 'get-url', 'origin'])).trim();
  } catch {
    throw new Error('這個 repo 沒有 origin remote，無法確認 CI run 屬於哪個 GitHub repo');
  }
  const slug = parseGithubSlug(url);
  if (!slug) throw new Error(`origin（${url.replace(/\/\/[^@/]+@/, '//')}）不是 github.com 的 repo，無法確認 CI run`);
  return slug;
}

/**
 * Run id from a numeric id or a run URL (`https://github.com/<o>/<r>/actions/runs/<id>[/...]`).
 * @param {string} input @returns {{ runId: string, slug: string|null }|null} slug only when a URL was given
 */
export function parseRunRef(input) {
  const s = String(input ?? '').trim();
  if (/^[1-9]\d*$/.test(s)) return { runId: s, slug: null };
  const m = s.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)(?:[/?#].*)?$/);
  return m && validParts(m[1], m[2]) ? { runId: m[3], slug: `${m[1]}/${m[2]}` } : null;
}

/**
 * The red-green job of a run: named `red-green` (trust-kit's own workflow) or `<caller job> / red-green` (the
 * reusable workflow called from another repo).
 * @param {WorkflowJob[]} jobs
 */
export const redGreenJobs = (jobs) => (Array.isArray(jobs) ? jobs : []).filter((j) => j?.name === 'red-green' || String(j?.name).endsWith(' / red-green'));

/** @param {string[]} args @returns {Promise<string>} */
function gh(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} 失敗：${String(stderr || err.message).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

/** @type {GithubClient} */
export const ghClient = {
  async getRun(slug, runId) {
    return JSON.parse(await gh(['api', `repos/${slug}/actions/runs/${runId}`]));
  },
  async getJobs(slug, runId) {
    return JSON.parse(await gh(['api', `repos/${slug}/actions/runs/${runId}/jobs?per_page=100`])).jobs ?? [];
  },
  async downloadRedGreen(slug, runId, destDir) {
    await gh(['run', 'download', runId, '-R', slug, '-n', RED_GREEN_ARTIFACT, '-D', destDir]);
  },
};
