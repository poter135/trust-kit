import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubSlug, parseRunRef } from '../src/github.mjs';

test('parseGithubSlug: https, ssh and scp-like GitHub remotes; anything else is null', () => {
  assert.equal(parseGithubSlug('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(parseGithubSlug('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(parseGithubSlug('ssh://git@github.com/acme/app'), 'acme/app');
  assert.equal(parseGithubSlug('https://gitlab.com/acme/app.git'), null);
});

test('parseGithubSlug / parseRunRef refuse "." and ".." as owner or repo', () => {
  assert.equal(parseGithubSlug('https://github.com/../app.git'), null);
  assert.equal(parseGithubSlug('git@github.com:acme/...git'), null);
  assert.equal(parseGithubSlug('git@github.com:acme/..'), null);
  assert.equal(parseRunRef('https://github.com/../../actions/runs/5'), null);
  assert.deepEqual(parseRunRef('https://github.com/acme/app/actions/runs/5/attempts/2'), { runId: '5', slug: 'acme/app' });
});
