import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepareCandidate, validateCandidate, candidateArtifact } from '../release-candidate.mjs';
import { packageFixture } from './package-fixture.mjs';
import { releaseFixture } from './release-fixture.mjs';
const repository = 'example/palmagent';

for (const version of ['0.1.0-alpha.1', '0.1.0']) test(`commit candidate ${version} binds bytes and notes before any tag exists`, (t) => {
  const f = releaseFixture(t, version), directory = join(f.root, 'bundle');
  const pkg = packageFixture(directory, { version, sourceCommit: f.source });
  const candidate = prepareCandidate(f.root, directory, f.source, 42, repository);
  const options = { commit: f.source, runId: 42, repository, sha256: candidate.sha256 };
  assert.equal(f.git('tag', '--list'), '');
  assert.equal(validateCandidate(f.root, directory, options).version, version);
  assert.throws(() => validateCandidate(f.root, directory, { ...options, sha256: 'a'.repeat(64) }), /changed after/);
  assert.throws(() => validateCandidate(f.root, directory, { ...options, runId: 43 }), /producer differs/);
  writeFileSync(join(directory, 'RELEASE_NOTES.md'), 'replacement notes');
  assert.throws(() => validateCandidate(f.root, directory, options), /notes mismatch/);
  prepareCandidate(f.root, directory, f.source, 42, repository);
  writeFileSync(pkg.path, 'replacement package');
  assert.throws(() => validateCandidate(f.root, directory, options), /checksum mismatch/);
});

test('recovery refuses foreign, untrusted, ambiguous, absent, or expired candidate storage', () => {
  const commit = 'a'.repeat(40), name = `palmagent-candidate-${commit}`;
  const run = { id: 1, repository: { full_name: repository }, path: '.github/workflows/release-candidate.yml', event: 'workflow_dispatch', head_branch: 'develop', head_sha: commit };
  const adapters = { api: () => run, pages: () => [{ name, expired: false }], reuse: true };
  assert.deepEqual(candidateArtifact(commit, 1, repository, adapters), { artifact: name, producer: '1', reuse: true });
  assert.throws(() => candidateArtifact(commit, 1, repository, { ...adapters, pages: () => [] }), /unavailable/);
  assert.throws(() => candidateArtifact(commit, 1, repository, { ...adapters, pages: () => [{ name, expired: true }] }), /expired/);
  assert.throws(() => candidateArtifact(commit, 1, repository, { ...adapters, pages: () => [{ name }, { name }] }), /ambiguous/);
  for (const mutation of [{ head_branch: 'feature/other' }, { event: 'pull_request' }, { path: '.github/workflows/other.yml' }, { repository: { full_name: 'other/repo' } }]) {
    assert.throws(() => candidateArtifact(commit, 1, repository, { ...adapters, api: () => ({ ...run, ...mutation }) }));
  }
});
