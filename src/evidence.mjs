// Evidence bundle: machine evidence an item needs before anyone may call it "fixed".
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { resolveCommit } from './git.mjs';
import { loadItem } from './items.mjs';
import { readScreens } from './screens.mjs';

export const RED_GREEN_SCHEMA = 'trust-kit/red-green@1';
const FULL_SHA = /^[0-9a-f]{40}$/;
const short = (s) => String(s ?? '').slice(0, 12);
const REFETCH = '請等 CI 對目前 commit 重跑後重新下載 trust-red-green artifact。';

/**
 * @typedef {{ name: string, ok: boolean, detail: string }} Check
 * @typedef {{ schema: 'trust-kit/evidence@1', item: import('./items.mjs').Item, commit: string,
 *   redGreen: { verdict: string|null, ciRunUrl: string|null, head: string|null },
 *   screens?: import('./screens.mjs').ScreensManifest, checks: Check[], complete: boolean, missing: string[] }} EvidenceBundle
 */

/** Why a non-valid_red verdict is not evidence, and how to fix it. @param {string} v */
function verdictFix(v) {
  switch (v) {
    case 'no_red': return `紅綠燈判定為 no_red：變更的測試在 base 上沒有失敗。請補一個在 base 上應失敗的測試（以行為／assertion 失敗，不是編譯或載入錯誤），commit 後${REFETCH}`;
    case 'invalid_red': return `紅綠燈判定為 invalid_red：測試在 base 上只有載入／編譯失敗（或新強制的規則未被證明），不算紅燈。請改成在 base 上應失敗的測試（以行為／assertion 失敗），commit 後${REFETCH}`;
    case 'head_fail': return `紅綠燈判定為 head_fail：變更的測試在目前 commit 上仍失敗。請修到測試通過，commit 後${REFETCH}`;
    case 'no_tests': return `紅綠燈判定為 no_tests：這次變更沒有改到任何測試。請新增在 base 上應失敗的測試，commit 後${REFETCH}`;
    default: return `紅綠燈判定為 ${JSON.stringify(v)}，不是 valid_red。請確認報告來自 CI 的 trust-red-green artifact，並補一個在 base 上應失敗的測試。`;
  }
}

/** @param {string} p @returns {{ report?: any, problem?: string }} */
function readRedGreen(p) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return { problem: `讀不到紅綠燈報告 ${p}（${e.code ?? e.message}）。請從 CI 下載目前 commit 的 trust-red-green artifact，並以 --red-green 指向其中的 JSON。` };
  }
  if (!report || report.schema !== RED_GREEN_SCHEMA) {
    return { problem: `紅綠燈報告格式不符：schema=${JSON.stringify(report?.schema)}，應為 ${RED_GREEN_SCHEMA}。請使用 trust-kit red-green 產生的 trust-red-green artifact。` };
  }
  return { report };
}

/** @param {string} repoRoot @param {string} rev */
async function fullSha(repoRoot, rev) {
  return FULL_SHA.test(rev) ? rev : resolveCommit(repoRoot, rev);
}

/**
 * @param {{ repoRoot: string, itemId: string, commit: string, redGreenPath: string, screensDir?: string }} opts
 *   `screensDir` defaults to `<config.evidence.screensDir>/<itemId>`; relative paths resolve against repoRoot.
 * @returns {Promise<EvidenceBundle>} throws only on bad input (item id/file, unresolvable commit, config)
 */
export async function buildEvidence({ repoRoot, itemId, commit, redGreenPath, screensDir }) {
  const item = loadItem(repoRoot, itemId);
  const config = loadConfig(repoRoot);
  const sha = await fullSha(repoRoot, commit);
  /** @type {Check[]} */
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const { report, problem } = readRedGreen(path.resolve(repoRoot, redGreenPath));
  const redGreen = {
    verdict: typeof report?.verdict === 'string' ? report.verdict : null,
    ciRunUrl: typeof report?.ciRunUrl === 'string' && report.ciRunUrl ? report.ciRunUrl : null,
    head: typeof report?.head === 'string' ? report.head : null,
  };
  if (!report) {
    check('red-green.report', false, /** @type {string} */ (problem));
  } else {
    check('red-green.verdict', redGreen.verdict === 'valid_red',
      redGreen.verdict === 'valid_red' ? 'valid_red' : verdictFix(String(redGreen.verdict)));
    check('red-green.head', redGreen.head === sha, redGreen.head === sha ? `head=${short(sha)}`
      : `紅綠燈報告與目前 commit 不符：報告 head=${short(redGreen.head)}，目前 commit=${short(sha)}。${REFETCH}`);
    check('red-green.ciRunUrl', redGreen.ciRunUrl !== null, redGreen.ciRunUrl ?? '紅綠燈報告沒有 ciRunUrl：報告不是在 CI 產生的。請使用 CI 上傳的 trust-red-green artifact，不要用本機產生的報告。');
    const ruleIds = Array.isArray(report.ruleProblems) ? report.ruleProblems.map((p) => String(p?.ruleId)) : [];
    if (ruleIds.length > 0) {
      check('red-green.rules', false, `紅綠燈報告列出未被證明的新強制規則：${ruleIds.join('、')}。請讓每條規則的檢查在 base 上失敗、在目前 commit 通過，commit 後${REFETCH}`);
    }
  }

  /** @type {import('./screens.mjs').ScreensManifest|undefined} */
  let screens;
  if (item.surfaces.includes('app') || item.surfaces.includes('web')) {
    const dir = path.resolve(repoRoot, screensDir ?? path.join(config.evidence.screensDir, itemId));
    screens = readScreens(dir);
    const howTo = `請截圖或錄影後執行 \`trust-kit screens collect --dir ${dir} --commit ${sha}\`，再以 --screens ${dir} 重跑 evidence。`;
    const n = screens?.files.length ?? 0;
    check('screens.files', n >= 1, n >= 1 ? `${n} file(s)`
      : `app／web 項目缺少畫面證據（screens）：${dir} 沒有 manifest.json 或沒有截圖。${howTo}`);
    if (screens) {
      let scSha = screens.commit;
      if (!FULL_SHA.test(scSha)) scSha = await resolveCommit(repoRoot, scSha).catch(() => scSha);
      const ok = scSha === sha;
      check('screens.commit', ok, ok ? `commit=${short(sha)}`
        : `畫面證據（screens）與目前 commit 不符：manifest commit=${short(screens.commit)}，目前 commit=${short(sha)}。請在目前 commit 上重新截圖，${howTo}`);
    }
  }

  const missing = checks.filter((c) => !c.ok).map((c) => c.detail);
  /** @type {EvidenceBundle} */
  const bundle = { schema: 'trust-kit/evidence@1', item, commit: sha, redGreen, checks, complete: missing.length === 0, missing };
  if (screens) bundle.screens = screens;
  return bundle;
}
