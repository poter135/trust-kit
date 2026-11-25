// Evidence bundle: machine evidence an item needs before anyone may call it "fixed".
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { resolveCommit } from './git.mjs';
import { loadItem } from './items.mjs';
import { readScreens } from './screens.mjs';
import { displayPath, scrubRepoRoot } from './paths.mjs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { ghClient, originSlug, parseRunRef, redGreenJobs, RED_GREEN_ARTIFACT } from './github.mjs';
import { isRedToGreen, matchesTestName } from './redgreen/judge.mjs';

export const RED_GREEN_SCHEMA = 'trust-kit/red-green@1';
const FULL_SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 12);
const REFETCH = '請等 CI 對目前 commit 重跑後，以 --run <該次 run 的 id 或網址> 重跑 evidence。';
export const EVIDENCE_SCHEMA = 'trust-kit/evidence@2';

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 * @typedef {import('./items.mjs').ItemTest & { base: string, head: string, ok: boolean }} ItemTestResult
 *   `base`/`head` are the statuses found in the CI report (`absent` when the test is not in it).
 * @typedef {{ schema: 'trust-kit/evidence@2', item: import('./items.mjs').Item, commit: string,
 *   redGreen: { verdict: string|null, ciRunUrl: string|null, runId: string|null, repo: string|null, head: string|null, base: string|null },
 *   screensDir?: string,
 *   tests: ItemTestResult[],
 *   screens?: import('./screens.mjs').ScreensManifest, checks: Check[], complete: boolean, missing: string[] }} EvidenceBundle
 *   `redGreen.ciRunUrl` comes from the GitHub API (the run's html_url), never from the report file.
 */

/** Why a non-valid_red verdict is not evidence, and how to fix it. @param {string} v */
function verdictFix(v) {
  switch (v) {
    case 'no_red': return `紅綠燈判定為 no_red：變更的測試在 base 上沒有失敗。請補一個在 base 上應失敗的測試（以行為／assertion 失敗，不是編譯或載入錯誤），commit 後${REFETCH}`;
    case 'invalid_red': return `紅綠燈判定為 invalid_red：測試在 base 上只有載入／編譯失敗（或新強制的規則未被證明），不算紅燈。請改成在 base 上應失敗的測試（以行為／assertion 失敗），commit 後${REFETCH}`;
    case 'head_fail': return `紅綠燈判定為 head_fail：變更的測試在目前 commit 上仍失敗。請修到測試通過，commit 後${REFETCH}`;
    case 'no_tests': return `紅綠燈判定為 no_tests：這次變更沒有改到任何測試。請新增在 base 上應失敗的測試，commit 後${REFETCH}`;
    default: return `紅綠燈判定為 ${JSON.stringify(v)}，不是 valid_red。請補一個在 base 上應失敗的測試。`;
  }
}

/** @param {string} file absolute path of the downloaded report @returns {{ report?: any, problem?: string }} */
function readRedGreen(file) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { problem: `CI run 的 ${RED_GREEN_ARTIFACT} artifact 裡讀不到 red-green.json（${e.code ?? e.message}）。${REFETCH}` };
  }
  if (!report || report.schema !== RED_GREEN_SCHEMA) {
    return { problem: `紅綠燈報告格式不符：schema=${JSON.stringify(report?.schema)}，應為 ${RED_GREEN_SCHEMA}。` };
  }
  return { report };
}

/**
 * Fetches the run and its red-green report from GitHub and checks the run itself. Never throws.
 * @param {{ repoRoot: string, runRef: string, sha: string, github: import('./github.mjs').GithubClient,
 *   check: (name: string, ok: boolean, detail: string) => void }} o
 * @returns {Promise<{ report?: any, run?: import('./github.mjs').WorkflowRun, slug?: string, runId?: string }>}
 */
async function fetchFromCi({ repoRoot, runRef, sha, github, check }) {
  let slug;
  try {
    slug = await originSlug(repoRoot);
  } catch (e) {
    check('ci.repo', false, `${e.message}。證據只接受同一個 GitHub repo 的 CI run 產生的紅綠燈報告。`);
    return {};
  }
  const ref = parseRunRef(runRef);
  if (!ref) {
    check('ci.run', false, `--run ${JSON.stringify(runRef)} 不是 GitHub Actions run 的 id 或網址（https://github.com/<owner>/<repo>/actions/runs/<id>）。`);
    return { slug };
  }
  if (ref.slug && ref.slug.toLowerCase() !== slug.toLowerCase()) {
    check('ci.repo', false, `CI run 網址屬於 ${ref.slug}，不是這個 repo（origin＝${slug}）。請用這個 repo 的 PR 上 trust-kit red-green 那次 run。`);
    return { slug };
  }
  const { runId } = ref;
  let run;
  try {
    run = await github.getRun(slug, runId);
  } catch (e) {
    check('ci.run', false, `查不到 CI run ${runId}（${slug}）：${e.message}。請確認 gh 已登入、run id 正確。`);
    return { slug, runId };
  }
  const runRepo = String(run?.repository?.full_name ?? '');
  check('ci.repo', runRepo.toLowerCase() === slug.toLowerCase(), runRepo.toLowerCase() === slug.toLowerCase() ? `repo=${slug}`
    : `CI run ${runId} 屬於 ${runRepo || '（不明）'}，不是這個 repo（origin＝${slug}）。`);
  check('ci.commit', run?.head_sha === sha, run?.head_sha === sha ? `run head_sha=${short(sha)}`
    : `CI run ${runId} 跑的是 commit ${short(run?.head_sha)}，不是目前 commit ${short(sha)}。${REFETCH}`);
  const done = run?.status === 'completed' && run?.event === 'pull_request';
  check('ci.completed', done, done ? `pull_request run, ${run.conclusion}`
    : `CI run ${runId} 不是已完成的 pull_request run（event=${run?.event}，status=${run?.status}）。請等 PR 上的 trust-kit red-green 跑完。`);

  let jobs;
  try {
    jobs = redGreenJobs(await github.getJobs(slug, runId));
  } catch (e) {
    jobs = null;
    check('ci.redGreenJob', false, `查不到 CI run ${runId} 的 jobs：${e.message}`);
  }
  if (jobs) {
    const ok = jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].conclusion === 'success';
    check('ci.redGreenJob', ok, ok ? `${jobs[0].name}: success`
      : jobs.length === 0 ? `CI run ${runId} 沒有 red-green job（名稱為 red-green 或 <job> / red-green），不是 trust-kit 紅綠燈的 run。`
        : `CI run ${runId} 的 red-green job 沒有成功（${jobs.map((j) => `${j.name}: ${j.status}/${j.conclusion}`).join('、')}）。紅綠燈、protected 或 ledger verify 失敗的 run 不能當證據。`);
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'trust-kit-ci-'));
  try {
    try {
      await github.downloadRedGreen(slug, runId, tmp);
    } catch (e) {
      const msg = scrubRepoRoot(repoRoot, String(e.message).split(tmp).join('<download-dir>'));
      check('red-green.report', false, `下載 CI run ${runId} 的 ${RED_GREEN_ARTIFACT} artifact 失敗：${msg}`);
      return { slug, runId, run };
    }
    const { report, problem } = readRedGreen(path.join(tmp, 'red-green.json'));
    if (!report) check('red-green.report', false, /** @type {string} */ (problem));
    return { slug, runId, run, report };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * One result per test the item names: ok only when the CI report has a row for it (same runner and file, name
 * matching) that failed on base by behavior and passes on head.
 * @param {import('./items.mjs').ItemTest[]} tests @param {any} report @returns {ItemTestResult[]}
 */
function itemTestResults(tests, report) {
  const runners = Array.isArray(report?.runners) ? report.runners : [];
  return tests.map((t) => {
    const rows = (runners.find((r) => r?.id === t.runnerId)?.tests ?? [])
      .filter((r) => r?.file === t.file && typeof r?.name === 'string' && matchesTestName(r.name, t.testName));
    if (rows.length > 1) return { ...t, base: 'ambiguous', head: `${rows.length} matches`, ok: false };
    const [only] = rows;
    return { ...t, base: only?.base ?? 'absent', head: only?.head ?? 'absent', ok: !!only && isRedToGreen(only) };
  });
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Re-checks every manifest entry against the files on disk. Returns one zh-TW problem per bad entry.
 * @param {string} dir screens dir @param {unknown[]} files manifest `files`
 * @returns {string[]}
 */
function verifyScreenFiles(dir, files) {
  const problems = [];
  files.forEach((f, i) => {
    const rel = f && typeof f === 'object' ? /** @type {any} */ (f).path : undefined;
    const sum = f && typeof f === 'object' ? /** @type {any} */ (f).sha256 : undefined;
    const label = typeof rel === 'string' ? rel : `files[${i}]`;
    if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
      problems.push(`${label} 的 path 無效（必須是 screens 目錄內的相對路徑）`); return;
    }
    if (typeof sum !== 'string' || !SHA256.test(sum)) { problems.push(`${label} 的 sha256 無效（必須是 64 碼十六進位）`); return; }
    let bytes;
    try { bytes = fs.readFileSync(path.join(dir, rel)); } catch { problems.push(`${label} 檔案不存在`); return; }
    if (createHash('sha256').update(bytes).digest('hex') !== sum) problems.push(`${label} 的內容在 collect 後被改過（sha256 不符）`);
  });
  return problems;
}

/** @param {string} repoRoot @param {string} rev */
async function fullSha(repoRoot, rev) {
  return FULL_SHA.test(rev) ? rev : resolveCommit(repoRoot, rev);
}

/**
 * Evidence only accepts the red-green report of a GitHub Actions run of this repo (origin) for this commit: the run
 * is looked up through the GitHub API (repo, head_sha, completed pull_request run) and its `trust-red-green` artifact
 * is downloaded here — a local file is never accepted. Each test the item names must go behavior_fail → pass.
 * @param {{ repoRoot: string, itemId: string, commit: string, runId: string, screensDir?: string,
 *   github?: import('./github.mjs').GithubClient }} opts
 *   `runId`: the run's id or URL. `screensDir` defaults to `<config.evidence.screensDir>/<itemId>`; relative paths
 *   resolve against repoRoot. `github` defaults to the `gh` CLI.
 * @returns {Promise<EvidenceBundle>} throws only on bad input (item id/file, unresolvable commit, config)
 */
export async function buildEvidence({ repoRoot, itemId, commit, runId, screensDir, github = ghClient }) {
  const item = loadItem(repoRoot, itemId);
  const config = loadConfig(repoRoot);
  const sha = await fullSha(repoRoot, commit);
  /** @type {Check[]} */
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const ci = await fetchFromCi({ repoRoot, runRef: runId, sha, github, check });
  const { report, run } = ci;
  const redGreen = {
    verdict: typeof report?.verdict === 'string' ? report.verdict : null,
    ciRunUrl: typeof run?.html_url === 'string' ? run.html_url : null,
    runId: ci.runId ?? null,
    repo: ci.slug ?? null,
    head: typeof report?.head === 'string' ? report.head : null,
    base: typeof report?.base === 'string' ? report.base : null,
  };
  if (report) {
    check('red-green.verdict', redGreen.verdict === 'valid_red',
      redGreen.verdict === 'valid_red' ? 'valid_red' : verdictFix(String(redGreen.verdict)));
    check('red-green.head', redGreen.head === sha, redGreen.head === sha ? `head=${short(sha)}`
      : `紅綠燈報告與目前 commit 不符：報告 head=${short(redGreen.head)}，目前 commit=${short(sha)}。${REFETCH}`);
    const sameRun = typeof report.ciRunUrl === 'string' && redGreen.ciRunUrl !== null && report.ciRunUrl === redGreen.ciRunUrl;
    check('red-green.ciRunUrl', sameRun, sameRun ? report.ciRunUrl
      : `紅綠燈報告的 ciRunUrl（${JSON.stringify(report.ciRunUrl ?? null)}）不是這次 CI run（${redGreen.ciRunUrl}）：報告不是這次 run 在 CI 上產生的。`);
    const ruleIds = Array.isArray(report.ruleProblems) ? report.ruleProblems.map((p) => String(p?.ruleId)) : [];
    if (ruleIds.length > 0) {
      check('red-green.rules', false, `紅綠燈報告列出未被證明的新強制規則：${ruleIds.join('、')}。請讓每條規則的檢查在 base 上失敗、在目前 commit 通過，commit 後${REFETCH}`);
    }
  }

  const tests = itemTestResults(item.tests, report);
  if (item.tests.length === 0) {
    check('item.tests', false, `項目 ${item.id} 沒有列出證明它的測試（tests）。請在 .trust/items/${item.id}.json 加上 tests: [{ runnerId, file, testName }]，指向這個項目自己在 base 上應以行為失敗、在目前 commit 通過的測試。`);
  }
  for (const t of tests) {
    check(`item.test:${t.file}::${t.testName}`, t.ok, t.ok ? `${t.file} › ${t.testName}: behavior_fail → pass`
      : `項目 ${item.id} 的測試 ${t.file} › ${JSON.stringify(t.testName)}（runner ${t.runnerId}）在紅綠燈報告中不是 behavior_fail → pass（base=${t.base}，head=${t.head}${t.base === 'ambiguous' ? '：名稱對到不只一個測試，請寫完整名稱 `describe > test`' : ''}）。整個 PR 的 valid_red 不能代替這個項目自己的紅燈。`);
  }

  /** @type {import('./screens.mjs').ScreensManifest|undefined} */
  let screens;
  /** @type {string|undefined} */
  let screensShown;
  if (item.surfaces.includes('app') || item.surfaces.includes('web')) {
    const dir = path.resolve(repoRoot, screensDir ?? path.join(config.evidence.screensDir, itemId));
    screens = readScreens(dir);
    const shown = displayPath(repoRoot, dir);
    screensShown = shown;
    const howTo = `請截圖或錄影後執行 \`trust-kit screens collect --dir ${shown} --commit ${sha}\`，再以 --screens ${shown} 重跑 evidence。`;
    const n = screens?.files.length ?? 0;
    check('screens.files', n >= 1, n >= 1 ? `${n} file(s)`
      : `app／web 項目缺少畫面證據（screens）：${shown} 沒有 manifest.json 或沒有截圖。${howTo}`);
    if (screens) {
      const ok = screens.commit === sha;
      check('screens.commit', ok, ok ? `commit=${short(sha)}`
        : `畫面證據（screens）與目前 commit 不符：manifest commit=${JSON.stringify(screens.commit)}，目前 commit=${short(sha)}（manifest 必須記錄完整 40 碼 SHA）。請在目前 commit 上重新截圖並重新執行 screens collect：${howTo}`);
      const problems = verifyScreenFiles(dir, screens.files);
      check('screens.integrity', problems.length === 0, problems.length === 0 ? 'all files match manifest'
        : `畫面證據（screens）與 manifest 不符：${problems.join('；')}。請重新執行 screens collect：${howTo}`);
    }
  }

  const missing = checks.filter((c) => !c.ok).map((c) => c.detail);
  /** @type {EvidenceBundle} */
  const bundle = { schema: EVIDENCE_SCHEMA, item, commit: sha, redGreen, tests, checks, complete: missing.length === 0, missing };
  if (screens) bundle.screens = screens;
  if (screensShown !== undefined) bundle.screensDir = screensShown;
  return bundle;
}
