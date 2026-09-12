import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { finalizeRelease, ensureReleaseTag, ensureReleaseAssets } from '../release-finalize.mjs';
import { prepareCandidate } from '../release-candidate.mjs';
import { packageFixture } from './package-fixture.mjs';
import { releaseFixture } from './release-fixture.mjs';

for (const version of ['0.1.0-alpha.1', '0.1.0']) test(`${version}: validate first, then tag, publish exact bytes, and expose Release last; retry is immutable`, async (t) => {
  const f = releaseFixture(t, version), directory = join(f.root, 'bundle');
  const pkg = packageFixture(directory, { version, sourceCommit: f.source });
  const candidate = prepareCandidate(f.root, directory, f.source, 42, 'example/palmagent');
  const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only', NPM_PUBLISH_ENABLED: 'true',
    RELEASE_COMMIT: f.source, CANDIDATE_RUN_ID: '42', GH_REPO: 'example/palmagent', EXPECTED_ARTIFACT_SHA256: candidate.sha256,
    RELEASE_ENVIRONMENT: `npm-${candidate.channel}` };
  const bytes = readFileSync(pkg.path), calls = [], assets = new Map();
  let tagObject, release, published = false, reviewers = false, failAfterNpm = false;
  const metadata = () => ({ versions: published ? { [version]: { dist: { integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } } : {},
    'dist-tags': published ? { [candidate.channel]: version } : {} });
  const adapters = {
    metadata: async () => metadata(), tarball: async () => bytes, skipFetch: true,
    checkTag: (value, object) => ({ tag: value.tag, tagObject: object, commit: value.commit, version, channel: value.channel, branch: value.branch }),
    releases: () => release ? [release] : [],
    assets: { download: (asset) => assets.get(asset.name), upload: (name, value) => { assets.set(name, value); release.assets.push({ name }); calls.push('asset'); } },
    publish: () => { calls.push('npm'); published = true; if (failAfterNpm) throw new Error('connection lost after upload'); },
    api: (path, options) => {
      if (path.startsWith('environments/')) return { name: env.RELEASE_ENVIRONMENT, protection_rules: reviewers ? [{ type: 'required_reviewers', reviewers: [{}] }] : [] };
      if (path.startsWith('git/matching-refs')) return tagObject ? [{ ref: `refs/tags/${candidate.tag}`, object: { type: 'tag', sha: tagObject } }] : [];
      if (path.startsWith('git/tags/')) return { tag: candidate.tag, object: { type: 'commit', sha: f.source } };
      if (path === 'git/tags') { calls.push('tag'); tagObject = 'b'.repeat(40); return { sha: tagObject }; }
      if (path === 'git/refs') return {};
      if (path === 'releases') { calls.push('draft'); release = { id: 1, tag_name: candidate.tag, prerelease: candidate.channel === 'next', draft: true, assets: [], html_url: 'https://example.invalid/release' }; return release; }
      assert.equal(path, 'releases/1'); assert.equal(options.body.draft, false); calls.push('public'); release.draft = false;
    },
  };
  await assert.rejects(finalizeRelease(f.root, directory, { ...env, EXPECTED_ARTIFACT_SHA256: 'a'.repeat(64) }, adapters), /changed after/);
  if (candidate.channel === 'latest') await assert.rejects(finalizeRelease(f.root, directory, env, adapters), /must have required reviewers/);
  assert.deepEqual(calls, []);
  reviewers = true; failAfterNpm = true;
  await assert.rejects(finalizeRelease(f.root, directory, env, adapters), /connection lost/);
  assert.equal(release.draft, true); assert.equal(published, true); assert(!calls.includes('public'));
  failAfterNpm = false;
  const result = await finalizeRelease(f.root, directory, env, adapters);
  assert.equal(result.publication, 'already-published');
  assert.equal(calls.filter((call) => call === 'npm').length, 1);
  assert.equal(calls.filter((call) => call === 'tag').length, 1);
  assert.equal(calls.at(-1), 'public');
  const before = calls.slice(); await finalizeRelease(f.root, directory, env, adapters); assert.deepEqual(calls, before);
  assets.set('SHA256SUMS', Buffer.from('changed'));
  await assert.rejects(finalizeRelease(f.root, directory, env, adapters), /asset differs/);
});

test('tag conflicts and published missing assets stop without overwrite', () => {
  const identity = { tag: 'v0.1.0', commit: 'a'.repeat(40) };
  assert.throws(() => ensureReleaseTag('', identity, () => [{ ref: 'refs/tags/v0.1.0', object: { type: 'commit' } }]), /annotated/);
  assert.throws(() => ensureReleaseTag('', identity, (path) => path.startsWith('git/matching') ? [{ ref: 'refs/tags/v0.1.0', object: { type: 'tag', sha: 'b'.repeat(40) } }]
    : { tag: 'v0.1.0', object: { type: 'commit', sha: 'c'.repeat(40) } }), /different source/);
  assert.throws(() => ensureReleaseAssets({ draft: false, assets: [] }, { 'package.tgz': Buffer.from('data') }, { upload: () => assert.fail('no upload') }), /missing an immutable asset/);
});
