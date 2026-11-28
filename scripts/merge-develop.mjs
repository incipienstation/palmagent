import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { delay, github } from './lib/release-github.mjs';
import { mergeVerifiedPR } from './lib/verified-pr.mjs';

// Compute the expected tree entirely from Git objects. The worker runs scripts from
// the trusted workflow checkout and never checks out or executes a PR's files.
function mergeTree(pr, head, base) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('fetch', '--no-tags', 'origin', `refs/pull/${pr}/head`, 'refs/heads/develop');
  return git('merge-tree', '--write-tree', head, base);
}

export async function mergeDevelop(repository, number, head, pinnedBase, {
  api = github, tree = mergeTree, sleep = delay, merge = mergeVerifiedPR,
} = {}) {
  assert(/^[1-9]\d*$/.test(number) && /^[a-f0-9]{40}$/.test(head), 'Invalid PR number or head');
  assert(!pinnedBase || /^[a-f0-9]{40}$/.test(pinnedBase), 'Invalid pinned base');
  const path = `pulls/${number}`;
  const pr = api(repository, path);
  assert(pr.base.ref === 'develop' && pr.head.repo?.full_name === repository
    && /^(feature|hotfix-sync)\//.test(pr.head.ref) && !pr.head.ref.startsWith('feature/preview-'),
    'Expected a task PR into develop. Preview preparations use the release workflow.');
  assert(pr.head.sha === head, 'Requested head changed. Review and enqueue the new head.');
  if (pr.merged) return pr.merge_commit_sha;
  assert(pr.state === 'open' && !pr.draft, 'PR closed or held as draft');
  assert(pinnedBase || !/^feature\/(stable-|codex-support-)/.test(pr.head.ref), 'This preparation requires a pinned base');
  const base = api(repository, 'git/ref/heads/develop').object.sha;
  assert(!pinnedBase || pinnedBase === base, 'Pinned base changed. Repeat the owning verification.');
  const comparison = api(repository, `compare/${base}...${head}`);
  assert(Number.isSafeInteger(comparison.behind_by) && comparison.behind_by >= 0, 'Incomplete base comparison');
  if (comparison.behind_by > 0) {
    assert(!pinnedBase, 'Verified head does not include its pinned base');
    const expectedTree = tree(number, head, base);
    api(repository, path + '/update-branch', { method: 'PUT', body: { expected_head_sha: head } });
    let updated = head;
    for (let i = 0; updated === head && i < 15; i++) {
      await sleep(2000);
      updated = api(repository, path).head.sha;
    }
    assert(updated !== head, 'Branch update is not visible. Inspect the PR before retrying.');
    const commit = api(repository, `git/commits/${updated}`);
    assert.deepEqual(commit.parents.map(parent => parent.sha), [head, base], 'Unexpected branch update parents');
    assert.equal(commit.tree.sha, expectedTree, 'Unexpected branch update contents');
    head = updated;
  }
  const merged = await merge(repository, pr, head, base);
  assert(merged, 'Develop advanced outside the queue. Review the PR and enqueue it again.');
  return merged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REF === 'refs/heads/develop', 'Expected trusted develop workflow');
  console.log('Merged commit:', await mergeDevelop(env.GITHUB_REPOSITORY, env.PR_NUMBER, env.PR_HEAD, env.PINNED_BASE));
}
