import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePreparationDispatch } from '../ci-preparation.mjs';
import { prepareVersion } from '../release-version.mjs';
import { addMaintenanceNotes } from '../preview-release.mjs';
import { releaseFixture } from './release-fixture.mjs';

test('dispatch accepts only the current Actions-owned metadata preparation at the checked-out SHA', (t) => {
  const f = releaseFixture(t), repository = 'example/palmagent', version = '0.1.0-alpha.2';
  addMaintenanceNotes(f.root, repository, null, f.source);
  prepareVersion(f.root, version, { apply: true });
  const head = f.commit(), branch = `feature/preview-${version}`;
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REPOSITORY: repository,
    GITHUB_SHA: head, GITHUB_REF: `refs/heads/${branch}` };
  const event = { inputs: { pr: '1', head } };
  const pr = { state: 'open', user: { login: 'github-actions[bot]' },
    head: { sha: head, ref: branch, repo: { full_name: repository } },
    base: { ref: 'develop', repo: { full_name: repository } },
    body: `<!-- palmagent-preview:${JSON.stringify({ source: f.source, version })} -->` };
  const adapter = (value = pr, source = f.source) => ({ api: (_repo, path) => path === 'pulls/1' ? value : { object: { sha: source } } });
  assert.doesNotThrow(() => validatePreparationDispatch(f.root, env, event, adapter()));
  for (const mutation of [{ state: 'closed' }, { draft: true }, { user: { login: 'someone' } },
    { head: { ...pr.head, sha: f.source } }, { head: { ...pr.head, ref: 'feature/unrelated' } },
    { head: { ...pr.head, repo: { full_name: 'other/repo' } } },
    { base: { ...pr.base, ref: 'main' } }, { body: '' }]) {
    assert.throws(() => validatePreparationDispatch(f.root, env, event, adapter({ ...pr, ...mutation })));
  }
  assert.throws(() => validatePreparationDispatch(f.root, { ...env, GITHUB_SHA: f.source }, event, adapter()), /ref advanced/);
  assert.throws(() => validatePreparationDispatch(f.root, env, event, adapter(pr, head)), /source is stale/);
  f.put('apps/server/src/index.ts', 'unexpected product change');
  const changed = f.commit();
  const bad = { ...pr, head: { ...pr.head, sha: changed }, body: `<!-- palmagent-preview:${JSON.stringify({ source: head, version })} -->` };
  assert.throws(() => validatePreparationDispatch(f.root, { ...env, GITHUB_SHA: changed }, { inputs: { pr: '1', head: changed } }, adapter(bad, head)), /outside release metadata/);
});
