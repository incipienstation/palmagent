#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCandidate } from './release-candidate.mjs';
import { checkTag } from './release-tag.mjs';
import { publishPackage, validatePublicationEnvironment } from './release-publish.mjs';
import { github, githubPages, registryMetadata, registryTarball } from './lib/release-github.mjs';
import { compareVersions } from './lib/release-version.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Called only inside the channel environment, after the Stable approval boundary.
export function ensureReleaseTag(cwd, identity, api) {
  const tags = api('git/matching-refs/tags/' + identity.tag);
  const existing = tags.find((ref) => ref.ref === `refs/tags/${identity.tag}`);
  if (existing) {
    assert(existing.object.type === 'tag', 'Release tag must be annotated');
    const object = api(`git/tags/${existing.object.sha}`);
    assert(object.tag === identity.tag && object.object.type === 'commit' && object.object.sha === identity.commit, 'Existing tag targets different source');
    return existing.object.sha;
  }
  const object = api('git/tags', { method: 'POST', body: {
    tag: identity.tag, object: identity.commit, type: 'commit', message: `Palmagent ${identity.version}\nSource: ${identity.commit}\n`,
  } });
  api('git/refs', { method: 'POST', body: { ref: `refs/tags/${identity.tag}`, sha: object.sha } });
  return object.sha;
}

export function ensureReleaseDraft(identity, candidate, releases, api) {
  const matches = releases.filter((release) => release.tag_name === identity.tag);
  assert(matches.length <= 1, 'Multiple releases for one tag');
  if (matches.length) {
    const release = matches[0];
    assert(release.prerelease === (identity.channel === 'next'), 'Existing release channel differs');
    return release;
  }
  return api('releases', { method: 'POST', body: {
    tag_name: identity.tag, target_commitish: identity.commit, name: `Palmagent ${identity.version}`,
    body: `${candidate.notes}\nSource commit: \`${identity.commit}\`\n\nValidation: ${candidate.runUrl}\n`,
    draft: true, prerelease: identity.channel === 'next', make_latest: 'false',
  } });
}

export function ensureReleaseAssets(release, files, { download, upload }) {
  for (const [name, bytes] of Object.entries(files)) {
    const existing = release.assets.filter((asset) => asset.name === name);
    assert(existing.length <= 1, 'Duplicate release assets');
    if (existing.length) {
      assert(download(existing[0]).equals(bytes), `Existing release asset differs: ${name}`);
    } else {
      assert(release.draft, 'Published release is missing an immutable asset');
      upload(name, bytes);
    }
  }
}

export async function finalizeRelease(cwd, directory, env, adapters = {}) {
  assert(env.GITHUB_ACTIONS === 'true' && env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, 'Finalization requires the protected Actions job');
  const candidate = validateCandidate(cwd, directory, { commit: env.RELEASE_COMMIT, runId: env.CANDIDATE_RUN_ID,
    repository: env.GH_REPO, sha256: env.EXPECTED_ARTIFACT_SHA256 });
  assert(env.EXPECTED_ARTIFACT_SHA256, 'Finalization requires the pre-approval checksum');
  assert(env.RELEASE_ENVIRONMENT === candidate.environment, 'Finalization environment mismatch');
  const api = adapters.api ?? ((path, options) => github(env.GH_REPO, path, options));
  validatePublicationEnvironment(candidate, api(`environments/${candidate.environment}`));
  assert(env.NPM_PUBLISH_ENABLED === 'true', 'Publication is not enabled');
  const metadata = adapters.metadata ?? registryMetadata;
  const before = await metadata();
  const current = before['dist-tags'][candidate.channel];
  assert(!current || compareVersions(current, candidate.version) <= 0, 'Candidate is older than the published channel; refusing to move it backwards');
  const integrity = `sha512-${createHash('sha512').update(readFileSync(candidate.path)).digest('base64')}`;
  assert(!before.versions[candidate.version] || before.versions[candidate.version].dist?.integrity === integrity,
    'Published version has different package bytes; never overwrite or reuse it');
  // Validate every supplied byte and the environment before any remote tag or release write.
  const tagObject = ensureReleaseTag(cwd, candidate, api);
  if (!adapters.skipFetch) execFileSync('git', ['fetch', 'origin', `refs/tags/${candidate.tag}:refs/tags/${candidate.tag}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const identity = adapters.checkTag ? adapters.checkTag(candidate, tagObject) : checkTag(cwd, candidate.tag, candidate.commit, tagObject);
  const manifest = { ...identity, filename: candidate.filename, sha256: candidate.sha256, runUrl: candidate.runUrl };
  const notes = readFileSync(join(directory, 'RELEASE_NOTES.md'), 'utf8');
  const releases = adapters.releases ? adapters.releases() : githubPages(env.GH_REPO, 'releases');
  const release = ensureReleaseDraft(identity, { ...candidate, notes }, releases, api);
  const files = {
    [candidate.filename]: readFileSync(candidate.path),
    'release.json': Buffer.from(JSON.stringify(manifest, null, 2) + '\n'),
    'SHA256SUMS': readFileSync(join(directory, 'SHA256SUMS')),
  };
  ensureReleaseAssets(release, files, adapters.assets ?? {
    download: (asset) => github(env.GH_REPO, `releases/assets/${asset.id}`, { binary: true }),
    upload: (name) => {
      // gh uploads from disk; no clobber flag is ever used. Partial drafts can fill only missing assets.
      if (name === 'release.json') writeFileSync(join(directory, name), files[name]);
      execFileSync('gh', ['release', 'upload', candidate.tag, join(directory, name), '--repo', env.GH_REPO], { stdio: ['ignore', 'pipe', 'pipe'] });
    },
  });
  const result = await publishPackage(candidate, {
    env, registryVersion: async (version) => (await metadata()).versions[version] ?? null,
    run: adapters.publish ?? ((command, args) => execFileSync(command, args, { stdio: 'inherit', env: { ...env, ALLOW_PUBLISH: '1' } })),
  });
  const registry = await metadata();
  const bytes = await (adapters.tarball ?? registryTarball)(registry.versions[candidate.version]);
  assert(createHash('sha256').update(bytes).digest('hex') === candidate.sha256, 'Published tarball differs from candidate');
  assert(createHash('sha512').update(bytes).digest('base64') === registry.versions[candidate.version].dist.integrity.slice(7), 'Published tarball integrity differs from registry');
  assert(registry['dist-tags'][candidate.channel] === candidate.version, 'Registry dist-tag differs; inspect before changing it');
  // Public release creation is the success marker used by Preview's next baseline.
  // A failed upload or registry verification leaves the exact draft available for recovery.
  if (release.draft) api(`releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: candidate.channel === 'latest' ? 'true' : 'false' } });
  return { ...manifest, publication: result, releaseUrl: release.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [source = '.', directory = 'build/release'] = process.argv.slice(2);
    const result = await finalizeRelease(resolve(source), resolve(directory), process.env);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Published palmagent@${result.version} to ${result.channel}\n\nCommit: ${result.commit}\n\nSHA-256: ${result.sha256}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
