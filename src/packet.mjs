// Review packet: the page a human reads before approving deploys/releases. Every approval binds to the packet head.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { scrubRepoRoot } from './paths.mjs';

export const PACKETS_DIR = '.trust/packets';
/** Stage 1 binds approvals to the git head only; batch-write plan hashes arrive in stage 2. */
export const BATCH_WRITE_UNSUPPORTED = '批次寫入計畫 hash 尚未支援（第二階段），不可核准';
const short = (s) => String(s ?? '').slice(0, 12);

/**
 * @typedef {{ n: number, item: string, kind: import('./items.mjs').Approval['kind']|null, target: string|null,
 *   commit: string, flagged: string[] }} PacketEntry
 *   `commit` is the packet head (git SHA). batch-write entries are flagged and not approvable in stage 1.
 * @typedef {{ id: string, markdown: string, entries: PacketEntry[], base: string, baseRef: string|null, head: string }} Packet
 * @typedef {{ id: string, entries: PacketEntry[], generatedAt: string, base: string, baseRef: string|null, head: string }} PacketRecord
 *   `base` is the merge-base the protected-change check diffed from; `baseRef` the branch it was computed with.
 */

/**
 * Per-item problems a reviewer must see before approving.
 * @param {import('./items.mjs').Item} item @param {import('./evidence.mjs').EvidenceBundle|null|undefined} ev @param {string} head
 * @param {string} repoRoot absolute paths under it in old bundles' `missing` are shown repo-relative
 * @returns {string[]}
 */
function itemFlags(item, ev, head, repoRoot) {
  if (!ev) return [`沒有證據包，請先執行 trust-kit evidence --item ${item.id}`];
  const out = [];
  if (ev.commit !== head) out.push(`證據包是舊 commit 的：證據包 commit=${short(ev.commit)}，審查包 head=${short(head)}。請在目前 commit 重新執行 trust-kit evidence --item ${item.id}`);
  if (ev.redGreen?.verdict !== 'valid_red') out.push(`紅綠燈判定不是 valid_red：${ev.redGreen?.verdict ?? '（沒有判定）'}`);
  if (ev.complete !== true) {
    const missing = Array.isArray(ev.missing) && ev.missing.length > 0 ? ev.missing : ['（證據包未列出原因）'];
    for (const m of missing) out.push(`證據不完整：${scrubRepoRoot(repoRoot, m)}`);
  }
  return out;
}

/**
 * Builds the review packet. Pure apart from reading trust.config.json for the screenshots directory.
 * `base` is shown in the markdown, so it is part of the packet id; base === head flags every entry, because then the
 * packet shows no change at all (protected changes cannot be detected).
 * @param {{ repoRoot: string, base: string, baseRef?: string|null, head: string,
 *   items: { item: import('./items.mjs').Item, evidence: import('./evidence.mjs').EvidenceBundle|null }[],
 *   protectedChanges: string[] }} opts
 *   `head` is the full commit every approval binds to; `evidence: null` means no bundle was found.
 * @returns {Packet}
 */
export function buildPacket({ repoRoot, base, baseRef = null, head, items, protectedChanges }) {
  if (typeof base !== 'string' || !/^[0-9a-f]{40}$/.test(base)) throw new Error(`buildPacket: base must be a full commit SHA, got ${JSON.stringify(base)}`);
  const screensDir = loadConfig(repoRoot).evidence.screensDir;
  const protectedFlag = protectedChanges.length > 0 ? [`驗證系統有改動：${protectedChanges.join('、')}`] : [];
  const sameBase = base === head ? [`base 與 head 相同（${short(head)}）：這份審查包看不到任何改動，也偵測不到驗證系統改動。請在合併前從工作分支產生審查包`] : [];

  /** @type {PacketEntry[]} */
  const entries = [];
  const attention = [...sameBase.map((f) => `- ${f}`), ...protectedChanges.map((p) => `- 驗證系統改動：\`${p}\``)];
  const blocks = [];
  for (const { item, evidence } of items) {
    const flags = itemFlags(item, evidence, head, repoRoot);
    const mine = [];
    for (const a of item.approvals.length > 0 ? item.approvals : [null]) {
      const e = { n: entries.length + 1, item: item.id, kind: a ? a.kind : null, target: a ? a.target : null,
        commit: head, flagged: [...flags, ...sameBase, ...protectedFlag, ...(a?.kind === 'batch-write' ? [BATCH_WRITE_UNSUPPORTED] : [])] };
      entries.push(e);
      mine.push(e);
    }
    const nums = mine.map((e) => e.n).join('、');
    for (const f of flags) attention.push(`- 第 ${nums} 項（${item.id}）：${f}`);
    for (const e of mine) if (e.kind === 'batch-write') attention.push(`- 第 ${e.n} 項（${item.id}）：${BATCH_WRITE_UNSUPPORTED}`);

    const lines = [`## ${nums}. ${item.title}（${item.id}）`, '', `- 改了什麼：${item.title}`];
    const ci = evidence?.redGreen?.ciRunUrl;
    lines.push(`- 紅綠燈：${evidence?.redGreen?.verdict ?? '（沒有證據包）'}${ci ? `（[CI](${ci})）` : '（沒有 CI 連結）'}`);
    const files = evidence?.screens?.files ?? [];
    if (files.length > 0) {
      lines.push('- 截圖：');
      for (const f of files) lines.push(`  - [${f.path}](${path.posix.join(screensDir, item.id, f.path)})（sha256 ${short(f.sha256)}）`);
    } else {
      lines.push('- 截圖：無');
    }
    lines.push('- 需要的核准：');
    for (const e of mine) {
      if (!e.kind) lines.push(`  - 第 ${e.n} 項：此項目沒有列出需要的核准（無法核准）`);
      else if (e.kind === 'batch-write') lines.push(`  - 第 ${e.n} 項：\`${e.kind}\`／\`${e.target}\`（${BATCH_WRITE_UNSUPPORTED}）`);
      else lines.push(`  - 第 ${e.n} 項：\`${e.kind}\`／\`${e.target}\`／commit \`${short(e.commit)}\``);
    }
    blocks.push(lines.join('\n'));
  }

  const markdown = [
    '# 審查包', '', `head：\`${short(head)}\`（${head}）`, '',
    `base：\`${short(base)}\`（${base}）${baseRef ? `＝ merge-base(${baseRef}, head)` : ''}，驗證系統改動從這裡比對`, '',
    '## 需要注意', '', ...(attention.length > 0 ? attention : ['- 無']), '',
    blocks.join('\n\n'), '',
  ].join('\n');
  return { id: createHash('sha256').update(markdown).digest('hex').slice(0, 12), markdown, entries, base, baseRef, head };
}

/**
 * Writes `<out>` (markdown), `<out>.json` and `.trust/packets/<id>.json` (the copy `recordApproval` reads).
 * @param {{ repoRoot: string, packet: Packet, out: string }} opts
 * @returns {PacketRecord}
 */
export function writePacket({ repoRoot, packet, out }) {
  /** @type {PacketRecord} */
  const record = { id: packet.id, entries: packet.entries, generatedAt: new Date().toISOString(),
    base: packet.base, baseRef: packet.baseRef, head: packet.head };
  const json = `${JSON.stringify(record, null, 2)}\n`;
  const outAbs = path.resolve(repoRoot, out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, packet.markdown);
  fs.writeFileSync(`${outAbs}.json`, json);
  const dir = path.join(repoRoot, PACKETS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${packet.id}.json`), json);
  return record;
}
