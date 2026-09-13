#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { checkTag } from './release-tag.mjs';
import { hashFile, inspectPackage } from './lib/package-artifact.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function validatePublication(cwd, directory, release, env) {
  const manifest = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
  assert(release.draft === false, 'Release must be explicitly published');
  const identity = checkTag(cwd, release.tag_name, manifest.commit, manifest.tagObject);
  assert(release.prerelease === (identity.channel === 'next'), 'GitHub release channel mismatch');
  for (const key of Object.keys(identity)) assert(identity[key] === manifest[key], `Manifest identity mismatch: ${key}`);
  assert(manifest.filename === `palmagent-${identity.version}.tgz`, 'Unexpected package filename');
  assert(/^[a-f0-9]{64}$/.test(manifest.sha256), 'Missing package checksum');
  const path = join(directory, manifest.filename);
  assert(hashFile(path) === manifest.sha256, 'Package checksum mismatch');
  assert(readFileSync(join(directory, 'SHA256SUMS'), 'utf8') === `${manifest.sha256}  ${manifest.filename}\n`, 'Checksum file mismatch');
  inspectPackage(path, { version: identity.version, commit: identity.commit, publishable: true });
  if (env.RELEASE_TAG) assert(env.RELEASE_TAG === identity.tag, 'Requested tag differs from release');
  return { ...identity, path, sha256: manifest.sha256, environment: `npm-${identity.channel}` };
}

export function validatePublicationEnvironment(identity, protection) {
  assert(['next', 'latest'].includes(identity.channel), 'Unknown npm publication channel');
  assert(identity.environment === `npm-${identity.channel}` && protection.name === identity.environment,
    'npm environment differs from release channel');
  if (identity.channel === 'latest') {
    assert(protection.protection_rules?.some((rule) => rule.type === 'required_reviewers' && rule.reviewers?.length > 0),
      'Stable npm environment must have required reviewers');
  }
}

export async function publishPackage(identity, { run, registryVersion, env, sleep = delay }) {
  assert(env.GITHUB_ACTIONS === 'true' && env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    'Publication requires GitHub Actions OIDC');
  assert(env.NPM_PUBLISH_ENABLED === 'true', 'Publication is not enabled for this repository');
  // Do not treat registry/network/auth failures as a missing version.
  const existing = await registryVersion(identity.version);
  if (existing) {
    assert(existing.dist?.integrity === `sha512-${hashFile(identity.path, 'sha512', 'base64')}`,
      'Published version has different package bytes; never overwrite or reuse it');
    return 'already-published'; // Retry after upload succeeded: no tag movement or overwrite.
  }
  run('npm', ['publish', identity.path, '--tag', identity.channel, '--access', 'public', '--provenance', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
  let published = await registryVersion(identity.version);
  // A successful upload can precede visibility through the registry's read endpoints.
  // Retry absence only: reported integrity conflicts and lookup errors remain fatal.
  for (let attempt = 0; !published && attempt < 12; attempt++) {
    await sleep(5000);
    published = await registryVersion(identity.version);
  }
  assert(published, 'Registry version is not visible after upload; retry with the original candidate');
  assert(published?.dist?.integrity === `sha512-${hashFile(identity.path, 'sha512', 'base64')}`, 'Registry package integrity verification failed');
  return 'published';
}

async function registryVersion(version) {
  const response = await fetch(`https://registry.npmjs.org/palmagent/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(15000) });
  if (response.status === 404) return null;
  assert(response.ok, 'npm registry lookup failed');
  return response.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const env = process.env;
    assert(/^[\w.-]+\/[\w.-]+$/.test(env.GH_REPO ?? ''), 'GH_REPO is required');
    assert(/^v[0-9A-Za-z.-]+$/.test(env.RELEASE_TAG ?? ''), 'RELEASE_TAG is required');
    const api = (endpoint) => JSON.parse(execFileSync('gh', ['api', `repos/${env.GH_REPO}/${endpoint}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    const release = api(`releases/tags/${env.RELEASE_TAG}`);
    const identity = validatePublication(process.cwd(), resolve('build/release'), release, env);
    if (env.EXPECTED_ARTIFACT_SHA256) assert(identity.sha256 === env.EXPECTED_ARTIFACT_SHA256, 'Artifact changed after approval preparation');
    const remote = api(`git/ref/tags/${identity.tag}`);
    assert(remote.object.type === 'tag' && remote.object.sha === identity.tagObject, 'Remote tag changed');
    const protection = api(`environments/${identity.environment}`);
    validatePublicationEnvironment(identity, protection);
    if (process.argv[2] === 'check') {
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `environment=${identity.environment}\ncommit=${identity.commit}\nversion=${identity.version}\nchannel=${identity.channel}\nsha256=${identity.sha256}\n`);
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Package: palmagent@${identity.version}\n\nChannel: ${identity.channel}\n\nCommit: ${identity.commit}\n\nSHA-256: ${identity.sha256}\n`);
      console.log(JSON.stringify(identity));
    } else if (process.argv[2] === 'publish') {
      console.log(await publishPackage(identity, {
        env, registryVersion,
        run: (command, args) => execFileSync(command, args, { stdio: 'inherit', env: { ...env, ALLOW_PUBLISH: '1' } }),
      }));
    } else throw new Error('Usage: node scripts/release-publish.mjs check|publish');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
