// Shared builders for packet/approval tests (not a test file itself).
export const HEAD = 'a'.repeat(40);
export const BASE = 'e'.repeat(40);

export const mkItem = (id, approvals = [{ kind: 'deploy-function', target: 'fnA' }], surfaces = ['functions']) =>
  ({ id, title: `Fix ${id}`, surfaces, acceptance: ['works'], approvals });

export const mkEvidence = (item, commitSha = HEAD, extra = {}) => ({
  schema: 'trust-kit/evidence@1', item, commit: commitSha,
  redGreen: { verdict: 'valid_red', ciRunUrl: 'https://ci.example/runs/9', head: commitSha },
  checks: [], complete: true, missing: [], ...extra,
});
