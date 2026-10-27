import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseGate } from './check-release-gate.mjs';

const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const repository = 'KeatonLi/kivo-git';
const run = { name: 'CI', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: sha, head_repository: { full_name: repository } };
const event = { action: 'completed', workflow_run: run };

test('allows the exact tested main commit and skips stale CI reruns', () => {
  assert.equal(releaseGate(event, repository, sha, sha), true);
  assert.equal(releaseGate(event, repository, sha, newer), false);
});

test('rejects untrusted or unsuccessful events, wrong repository, and wrong checkout', () => {
  for (const changed of [
    { action: 'requested' },
    { workflow_run: { ...run, name: 'Other' } },
    { workflow_run: { ...run, conclusion: 'failure' } },
    { workflow_run: { ...run, event: 'pull_request' } },
    { workflow_run: { ...run, head_branch: 'feature' } },
    { workflow_run: { ...run, head_repository: { full_name: 'someone/fork' } } },
    { workflow_run: { ...run, head_sha: 'not-a-sha' } }
  ]) assert.throws(() => releaseGate({ ...event, ...changed }, repository, sha, sha));
  assert.throws(() => releaseGate(event, repository, newer, sha));
  assert.throws(() => releaseGate(event, repository, sha, ''));
});
