// Shared builders for packet/approval tests (not a test file itself).
export const HEAD = 'a'.repeat(40);
export const BASE = 'e'.repeat(40);

export const mkItem = (id, approvals = [{ kind: 'deploy-function', target: 'fnA' }], surfaces = ['functions']) =>
  ({ id, title: `Fix ${id}`, surfaces, acceptance: ['works'], approvals,
    tests: [{ runnerId: 'unit', file: `test/${id}.test.mjs`, testName: `${id} works` }] });

export const mkEvidence = (item, commitSha = HEAD, extra = {}) => ({
  schema: 'trust-kit/evidence@2', item, commit: commitSha,
  redGreen: { verdict: 'valid_red', ciRunUrl: 'https://ci.example/runs/9', runId: '9', repo: 'acme/app', head: commitSha },
  tests: item.tests.map((t) => ({ ...t, base: 'behavior_fail', head: 'pass', ok: true })),
  checks: [], complete: true, missing: [], ...extra,
});
