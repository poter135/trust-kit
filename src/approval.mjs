// Approval records: which packet entries the user approved, and the check that refuses anything else.
// Stage 1: records are written by Claude from the user's chat reply. They catch commit drift, not forgery.
import fs from 'node:fs';
import path from 'node:path';
import { PACKETS_DIR, BATCH_WRITE_UNSUPPORTED } from './packet.mjs';

export const APPROVALS_DIR = '.trust/approvals';
const PACKET_ID = /^[0-9a-f]{12}$/;

/** Bad approval input; the CLI prints it without a stack. */
export class ApprovalError extends Error {}

/**
 * @typedef {{ packetId: string, head: string, approvedBy: 'user-chat', approvedAt: string,
 *   entries: (import('./packet.mjs').PacketEntry & { approvedAt: string })[] }} ApprovalRecord
 */

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/**
 * Approves entries of a packet; merges with earlier approvals of the same packet. Throws (and writes nothing)
 * on an unknown packet, unknown numbers, entries without a kind, or flagged entries unless `allowFlagged`.
 * @param {{ repoRoot: string, packetId: string, numbers: number[], allowFlagged?: boolean }} opts
 * @returns {ApprovalRecord}
 */
export function recordApproval({ repoRoot, packetId, numbers, allowFlagged = false }) {
  if (!PACKET_ID.test(String(packetId))) throw new ApprovalError(`審查包 id ${JSON.stringify(packetId)} 格式錯誤（應為 12 碼十六進位）`);
  const packetFile = path.join(repoRoot, PACKETS_DIR, `${packetId}.json`);
  let packet;
  try { packet = readJson(packetFile); } catch (e) {
    throw new ApprovalError(`找不到審查包 ${packetId}（${packetFile}：${e.code ?? e.message}）。請先執行 trust-kit packet`);
  }
  if (!Array.isArray(numbers) || numbers.length === 0) throw new ApprovalError('沒有指定要核准的編號');
  const now = new Date().toISOString();
  const picked = [];
  for (const n of numbers) {
    const e = packet.entries.find((x) => x.n === n);
    if (!e) throw new ApprovalError(`審查包 ${packetId} 沒有第 ${n} 項`);
    if (!e.kind) throw new ApprovalError(`第 ${n} 項（${e.item}）沒有列出需要的核准，無法核准`);
    if (e.kind === 'batch-write') throw new ApprovalError(`第 ${n} 項（${e.item}）：${BATCH_WRITE_UNSUPPORTED}（--allow-flagged 也不行）`);
    if (e.flagged.length > 0 && !allowFlagged) {
      throw new ApprovalError(`第 ${n} 項（${e.item}）有需要注意的問題，未加 --allow-flagged 不能核准：\n  ${e.flagged.join('\n  ')}`);
    }
    picked.push({ ...e, approvedAt: now });
  }

  const file = path.join(repoRoot, APPROVALS_DIR, `${packetId}.json`);
  /** @type {ApprovalRecord['entries']} */
  let entries = fs.existsSync(file) ? readJson(file).entries ?? [] : [];
  for (const p of picked) entries = [...entries.filter((e) => e.n !== p.n), p];
  entries.sort((a, b) => a.n - b.n);
  /** @type {ApprovalRecord} */
  const record = { packetId, head: packet.head, approvedBy: 'user-chat', approvedAt: now, entries };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * ok only if some approval record has an entry with the same kind, target and exact full commit SHA.
 * Stage 1: kind 'batch-write' is always refused (plan-hash approvals need stage 2).
 * @param {{ repoRoot: string, kind: string, target: string, commit: string }} opts
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkApproval({ repoRoot, kind, target, commit }) {
  if (kind === 'batch-write') {
    return { ok: false, reason: `batch-write／${target} 未核准：批次寫入需要以寫入計畫 hash 核准，須等第二階段支援；第一階段一律拒絕。` };
  }
  const dir = path.join(repoRoot, APPROVALS_DIR);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  const sameTarget = [];
  for (const f of files) {
    let rec;
    try { rec = readJson(path.join(dir, f)); } catch { continue; }
    for (const e of Array.isArray(rec?.entries) ? rec.entries : []) {
      if (e.kind !== kind || e.target !== target) continue;
      if (e.commit === commit) return { ok: true };
      sameTarget.push(`${e.commit}（審查包 ${rec.packetId}）`);
    }
  }
  if (sameTarget.length > 0) {
    return { ok: false, reason: `${kind}／${target} 核准的 commit 是 ${[...new Set(sameTarget)].join('、')}，目前的 commit 是 ${commit}，不符。請對目前 commit 重新產生審查包並取得核准。` };
  }
  return { ok: false, reason: `${kind}／${target}／${commit} 未核准：沒有任何核准紀錄包含這一項。請產生審查包並取得使用者核准。` };
}
