import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDevelop } from '../merge-develop.mjs';

test('a queued request can only advance to the exact integration of the authorized change', async () => {
  const repo = 'example/project', original = '1'.repeat(40), base = '2'.repeat(40), updated = '3'.repeat(40);
  const fixture = { tree: 'expected', parents: [original, base], draft: false };
  const submit = async (pinned = '') => {
    let current = original;
    return mergeDevelop(repo, '7', original, pinned, {
      sleep: async () => {},
      tree: () => 'expected',
      api(repository, path, options) {
        assert.equal(repository, repo);
        if (path === 'pulls/7') return { number: 7, base: { ref: 'develop' }, state: 'open', draft: fixture.draft,
          head: { ref: 'feature/example', sha: current, repo: { full_name: repo } } };
        if (path === 'git/ref/heads/develop') return { object: { sha: base } };
        if (path.startsWith('compare/')) return { behind_by: 1 };
        if (path === 'pulls/7/update-branch') {
          assert.equal(options.body.expected_head_sha, original);
          current = updated;
          return;
        }
        assert.equal(path, 'git/commits/' + updated);
        return { parents: fixture.parents.map(sha => ({ sha })), tree: { sha: fixture.tree } };
      },
      merge: async (repository, pr, sha, source) => {
        assert.deepEqual([repository, pr.number, sha, source], [repo, 7, updated, base]);
        return 'merged';
      },
    });
  };
  assert.equal(await submit(), 'merged');
  await assert.rejects(submit(original), /Pinned base changed/);
  fixture.tree = 'concurrent edit';
  await assert.rejects(submit(), /contents/);
  fixture.tree = 'expected'; fixture.parents = [original, updated];
  await assert.rejects(submit(), /parents/);
  fixture.draft = true;
  await assert.rejects(submit(), /draft/);
});
