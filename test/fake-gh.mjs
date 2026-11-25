// Shared GitHub fakes for evidence/packet tests (not a test file itself).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export const SLUG = 'acme/app';
export const RUN_ID = '4242';
export const RUN_URL = `https://github.com/${SLUG}/actions/runs/${RUN_ID}`;

export const mkRun = (sha, extra = {}) => ({
  id: Number(RUN_ID), html_url: RUN_URL, head_sha: sha, status: 'completed', conclusion: 'failure',
  event: 'pull_request', path: '.github/workflows/trust.yml', repository: { full_name: SLUG }, ...extra,
});
/** Jobs of the run: the red-green job succeeded; another job (e.g. a full test suite) failed. */
export const mkJobs = (redGreen = 'success') => [
  { name: 'red-green / red-green', status: 'completed', conclusion: redGreen },
  { name: 'Flutter test (full)', status: 'completed', conclusion: 'failure' },
];

/**
 * In-process fake client. `rep` null = the run has no trust-red-green artifact.
 * @param {{ run?: any, jobs?: any[], rep?: any, runError?: string }} o
 */
export function fakeGithub({ run, jobs = mkJobs(), rep, runError }) {
  return {
    async getRun(slug, id) {
      if (runError) throw new Error(runError);
      assert.equal(slug, SLUG);
      assert.equal(String(id), RUN_ID);
      return run;
    },
    async getJobs(slug, id) {
      assert.equal(slug, SLUG);
      assert.equal(String(id), RUN_ID);
      return jobs;
    },
    async downloadRedGreen(slug, _id, destDir) {
      assert.equal(slug, SLUG);
      if (rep === null) throw new Error('no artifact matches any of the names or patterns provided');
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, 'red-green.json'), typeof rep === 'string' ? rep : JSON.stringify(rep));
    },
  };
}

/** Env whose PATH starts with a fake `gh` serving RUN_ID (run, jobs, artifact). */
export function fakeGhEnv(dir, { run, jobs = mkJobs(), rep }) {
  const bin = path.join(dir, '..', `fakebin-${path.basename(dir)}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'run.json'), JSON.stringify(run));
  fs.writeFileSync(path.join(bin, 'jobs.json'), JSON.stringify({ total_count: jobs.length, jobs }));
  fs.writeFileSync(path.join(bin, 'report.json'), JSON.stringify(rep));
  const f = (n) => JSON.stringify(path.join(bin, n));
  const gh = path.join(bin, 'gh');
  fs.writeFileSync(gh, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2);
const runPath = 'repos/${SLUG}/actions/runs/${RUN_ID}';
if (a[0] === 'api' && a[1] === runPath) { process.stdout.write(fs.readFileSync(${f('run.json')}, 'utf8')); process.exit(0); }
if (a[0] === 'api' && a[1].startsWith(runPath + '/jobs')) { process.stdout.write(fs.readFileSync(${f('jobs.json')}, 'utf8')); process.exit(0); }
if (a[0] === 'run' && a[1] === 'download' && a[2] === '${RUN_ID}') {
  const d = a[a.indexOf('-D') + 1]; fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(${f('report.json')}, path.join(d, 'red-green.json')); process.exit(0);
}
process.stderr.write('fake gh: unexpected ' + a.join(' ')); process.exit(1);
`);
  fs.chmodSync(gh, 0o755);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
