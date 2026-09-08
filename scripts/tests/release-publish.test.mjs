import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile } from '../lib/package-artifact.mjs';
import { publishPackage, validatePublication } from '../release-publish.mjs';
import { checkTag, prepareBundle } from '../release-tag.mjs';
import { packageFixture } from './package-fixture.mjs';

const env = { GITHUB_ACTIONS: 'true', ACTIONS_ID_TOKEN_REQUEST_URL: 'oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-only', NPM_PUBLISH_ENABLED: 'true' };
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

test('publication binds a real clean package to released metadata, tag object, branch and checksums', () => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-publication-test-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_AUTHOR_NAME: 'Release Test', GIT_COMMITTER_NAME: 'Release Test',
        GIT_AUTHOR_EMAIL: 'release-test@localhost', GIT_COMMITTER_EMAIL: 'release-test@localhost', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-b', 'develop');
    const version = '0.1.0-alpha.1'; const tag = `v${version}`;
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
    writeFileSync(join(root, 'CHANGELOG.md'), `## ${version}\n\nRelease notes.\n`);
    git('add', '.'); git('commit', '-m', 'Release fixture');
    const commit = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/develop', commit); git('tag', '-a', tag, '-m', 'Release fixture');
    const directory = join(root, 'bundle');
    const fixture = packageFixture(directory, { sourceCommit: commit });
    const identity = checkTag(root, tag, commit);
    prepareBundle(root, directory, identity, 'https://example.invalid/run');
    const release = { tag_name: tag, draft: false, prerelease: true };
    assert.equal(validatePublication(root, directory, release, {}).environment, 'npm-next');
    assert.throws(() => validatePublication(root, directory, { ...release, draft: true }, {}), /explicitly published/);
    assert.throws(() => validatePublication(root, directory, { ...release, prerelease: false }, {}), /channel mismatch/);
    const manifestPath = join(directory, 'release.json'); const manifest = JSON.parse(readFileSync(manifestPath));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, branch: 'main' }));
    assert.throws(() => validatePublication(root, directory, release, {}), /identity mismatch: branch/);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(fixture.path, 'replacement bytes');
    assert.throws(() => validatePublication(root, directory, release, {}), /checksum mismatch/);
  } finally { rmSync(root, { recursive: true }); }
});
