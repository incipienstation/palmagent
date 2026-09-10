import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../lib/package-artifact.mjs';
import { publishPackage, validatePublication, validatePublicationEnvironment } from '../release-publish.mjs';
import { checkTag, prepareBundle } from '../release-tag.mjs';
import { packageFixture } from './package-fixture.mjs';

const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only', NPM_PUBLISH_ENABLED: 'true' };
test('prerelease publication needs no second reviewer; stable publication still fails closed', () => {
  const next = { channel: 'next', environment: 'npm-next' };
  const latest = { channel: 'latest', environment: 'npm-latest' };
  const branchRule = { type: 'branch_policy' };
  const reviewers = { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] };
  assert.doesNotThrow(() => validatePublicationEnvironment(next, { name: 'npm-next', protection_rules: [branchRule] }));
  // Retaining the old reviewer during rollout is safe; removing it enables automatic publication.
  assert.doesNotThrow(() => validatePublicationEnvironment(next, { name: 'npm-next', protection_rules: [reviewers, branchRule] }));
  assert.doesNotThrow(() => validatePublicationEnvironment(latest, { name: 'npm-latest', protection_rules: [reviewers, branchRule] }));
  for (const rules of [undefined, [], [branchRule], [{ type: 'required_reviewers', reviewers: [] }]]) {
    assert.throws(() => validatePublicationEnvironment(latest, { name: 'npm-latest', protection_rules: rules }), /must have required reviewers/);
  }
  assert.throws(() => validatePublicationEnvironment(latest, { name: 'npm-next', protection_rules: [reviewers] }), /differs from release channel/);
  assert.throws(() => validatePublicationEnvironment({ ...latest, environment: 'npm-next' }, { name: 'npm-next' }), /differs from release channel/);
  assert.throws(() => validatePublicationEnvironment({ channel: 'other', environment: 'npm-other' }, { name: 'npm-other' }), /Unknown npm publication channel/);
});

test('publish reviewed bytes once; retry checks registry integrity without moving dist-tags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-publish-test-'));
  try {
    const path = join(root, 'package.tgz'); writeFileSync(path, 'reviewed bytes');
    const identity = { path, version: '0.1.0-alpha.1', channel: 'next' };
    const published = { dist: { integrity: `sha512-${hashFile(path, 'sha512', 'base64')}` } };
    const calls = []; let exists = false;
    const adapters = { env, registryVersion: async () => exists ? published : null, run: (...args) => { calls.push(args); exists = true; } };
    assert.equal(await publishPackage(identity, adapters), 'published');
    assert.equal(calls.length, 1);
    assert(calls[0][1].includes('next'));
    assert(calls[0][1].includes('--provenance'));
    assert.equal(await publishPackage(identity, adapters), 'already-published');
    assert.equal(calls.length, 1);
    await assert.rejects(publishPackage(identity, { ...adapters, env: {} }), /OIDC/);
    await assert.rejects(publishPackage(identity, { ...adapters, env: { ...env, NPM_PUBLISH_ENABLED: 'false' } }), /not enabled/);
    await assert.rejects(publishPackage(identity, { ...adapters, registryVersion: async () => ({ dist: { integrity: 'other' } }) }), /different package/);
    await assert.rejects(publishPackage(identity, { ...adapters, registryVersion: async () => { throw new Error('registry unavailable'); } }), /registry unavailable/);
    assert.equal(calls.length, 1);
  } finally { rmSync(root, { recursive: true }); }
});

for (const version of ['0.1.0-alpha.1', '0.1.0-beta.1', '0.1.0-rc.1', '0.1.0']) {
  test(`publication binds ${version} to its channel, released metadata, tag object, branch and checksums`, () => {
    const root = mkdtempSync(join(tmpdir(), 'palmagent-publication-test-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_AUTHOR_NAME: 'Release Test', GIT_COMMITTER_NAME: 'Release Test',
          GIT_AUTHOR_EMAIL: 'release-test@localhost', GIT_COMMITTER_EMAIL: 'release-test@localhost', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
      const prerelease = version.includes('-');
      const branch = prerelease ? 'develop' : 'main';
      git('init', '-b', branch);
      const tag = `v${version}`;
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
      writeFileSync(join(root, 'CHANGELOG.md'), `## ${version}\n\nRelease notes.\n`);
      git('add', '.'); git('commit', '-m', 'Release fixture');
      const commit = git('rev-parse', 'HEAD');
      git('update-ref', `refs/remotes/origin/${branch}`, commit); git('tag', '-a', tag, '-m', 'Release fixture');
      const directory = join(root, 'bundle');
      const fixture = packageFixture(directory, { version, sourceCommit: commit });
      const identity = checkTag(root, tag, commit);
      prepareBundle(root, directory, identity, 'https://example.invalid/run');
      const release = { tag_name: tag, draft: false, prerelease };
      const publication = validatePublication(root, directory, release, {});
      assert.equal(publication.environment, prerelease ? 'npm-next' : 'npm-latest');
      const unreviewed = { name: publication.environment, protection_rules: [] };
      if (prerelease) assert.doesNotThrow(() => validatePublicationEnvironment(publication, unreviewed));
      else assert.throws(() => validatePublicationEnvironment(publication, unreviewed), /must have required reviewers/);
      assert.throws(() => validatePublication(root, directory, { ...release, draft: true }, {}), /explicitly published/);
      assert.throws(() => validatePublication(root, directory, { ...release, prerelease: !prerelease }, {}), /channel mismatch/);
      const manifestPath = join(directory, 'release.json'); const manifest = JSON.parse(readFileSync(manifestPath));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, branch: prerelease ? 'main' : 'develop' }));
      assert.throws(() => validatePublication(root, directory, release, {}), /identity mismatch: branch/);
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(fixture.path, 'replacement bytes');
      assert.throws(() => validatePublication(root, directory, release, {}), /checksum mismatch/);
    } finally { rmSync(root, { recursive: true }); }
  });
}
