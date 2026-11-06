import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BundleIdentitySchema, ChannelIndexSchema, RELEASE_PUBLIC_KEYS, StandaloneManifestSchema } from '../../packages/shared/src/standalone.ts';
import { inspectReleaseArchive, sha256File, verifySignedPayload } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
import { DISTRIBUTION } from './product.mjs';
import { compareVersions } from './release-version.mjs';

export const standaloneTargets = ['linux-x64-glibc', 'linux-arm64-glibc'];
export function supportsStandalone(cwd) {
  const path = join(cwd, 'packages/shared/src/distribution.json');
  return existsSync(path) && typeof JSON.parse(readFileSync(path, 'utf8')).releaseOrigin === 'string';
}

export function assembleStandaloneManifest(directory, identity, runId) {
  const reports = standaloneTargets.map(target => {
    const report = JSON.parse(readFileSync(join(directory, `${target}.json`), 'utf8'));
    const bundle = BundleIdentitySchema.parse(Object.fromEntries(Object.keys(BundleIdentitySchema.shape).map(key => [key, report[key]])));
    if (bundle.version !== identity.version || bundle.sourceCommit !== identity.commit || bundle.target !== target) throw new Error('Standalone candidate identity mismatch');
    return report;
  });
  if (reports.some(report => report.nodeVersion !== reports[0].nodeVersion || report.nodeAbi !== reports[0].nodeAbi)) throw new Error('Standalone runtimes differ between platforms');
  const npm = identity.version.includes('-') ? undefined : { filename: `palmagent-${identity.version}.tgz` };
  if (npm) npm.sha256 = sha256File(join(directory, npm.filename));
  const manifest = StandaloneManifestSchema.parse({ schemaVersion: 1, version: identity.version, sourceCommit: identity.commit,
    nodeVersion: reports[0].nodeVersion, nodeAbi: reports[0].nodeAbi, pluginTag: `v${identity.version}`, runId: String(runId),
    artifacts: reports.map(report => report.artifact), ...(npm ? { npm } : {}) });
  inspectStandaloneArtifacts(directory, manifest);
  writeFileSync(join(directory, 'standalone-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function inspectStandaloneArtifacts(directory, input) {
  const manifest = StandaloneManifestSchema.parse(input);
  for (const artifact of manifest.artifacts) {
    const file = join(directory, artifact.filename);
    if (artifact.url !== `${DISTRIBUTION.repositoryUrl}/releases/download/v${manifest.version}/${artifact.filename}` || sha256File(file) !== artifact.sha256)
      throw new Error('Standalone artifact identity or checksum mismatch');
    inspectReleaseArchive(file, artifact.size, artifact.unpackedSize);
  }
  if (manifest.npm && sha256File(join(directory, manifest.npm.filename)) !== manifest.npm.sha256) throw new Error('Stable npm artifact checksum mismatch');
  return manifest;
}

export function signReleaseDocument(value, keyId, privateKey, trustedKeys = RELEASE_PUBLIC_KEYS) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(keyId ?? '') || !Object.hasOwn(trustedKeys, keyId) || !privateKey) throw new Error('Release signing is not configured');
  let key;
  try { key = createPrivateKey(privateKey); } catch { throw new Error('Release signing key is invalid'); }
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).export({ type: 'spki', format: 'der' })
    .equals(createPublicKey(trustedKeys[keyId]).export({ type: 'spki', format: 'der' }))) throw new Error('Release signing key does not match the trusted public key');
  const payload = Buffer.from(JSON.stringify(value));
  return Buffer.from(JSON.stringify({ schemaVersion: 1, payload: payload.toString('base64'),
    signatures: [{ keyId, signature: sign(null, payload, key).toString('base64') }] }) + '\n');
}

export async function readChannel(channel, { fetcher = fetch, origin = DISTRIBUTION.releaseOrigin, keys = RELEASE_PUBLIC_KEYS } = {}) {
  const response = await fetcher(`${origin}/channels/${channel}.json`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Standalone channel is unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  const value = ChannelIndexSchema.parse(verifySignedPayload(bytes, keys));
  if (value.channel !== channel || value.releaseManifestUrl !== `${DISTRIBUTION.repositoryUrl}/releases/download/v${value.version}/standalone.json`)
    throw new Error('Standalone channel identity mismatch');
  const etag = response.headers.get('etag');
  if (!etag) throw new Error('Standalone channel has no conditional-write identity');
  return { value, bytes, etag };
}

export async function githubReleaseToken(env, fetcher = fetch) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub release identity is unavailable');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', DISTRIBUTION.releaseOrigin);
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Could not obtain release publication identity');
  const body = await response.json();
  if (typeof body.value !== 'string') throw new Error('Invalid release publication identity');
  return body.value;
}

export async function preflightStandalonePublication(manifest, signedManifest, env, { fetcher = fetch, keys = RELEASE_PUBLIC_KEYS, token = githubReleaseToken } = {}) {
  const channel = manifest.version.includes('-') ? 'preview' : 'stable';
  const probe = ChannelIndexSchema.parse({ schemaVersion: 1, channel, revision: 1, version: manifest.version,
    releaseManifestUrl: `${DISTRIBUTION.repositoryUrl}/releases/download/v${manifest.version}/standalone.json`,
    releaseManifestSha256: createHash('sha256').update(signedManifest).digest('hex') });
  const bytes = signReleaseDocument(probe, env.RELEASE_SIGNING_KEY_ID, env.RELEASE_SIGNING_KEY, keys);
  const identity = await token(env, fetcher);
  const response = await fetcher(`${DISTRIBUTION.releaseOrigin}/channels/${channel}.json`, { method: 'POST', body: bytes,
    headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (response.status !== 204) throw new Error('Standalone publication preflight failed; check the domain, bucket, OIDC policy and trust keys before creating a release');
}

/** Publication is complete only when the public channel reads back the pinned bytes. */
export async function publishStandaloneChannel(manifest, signedManifest, env, { fetcher = fetch, keys = RELEASE_PUBLIC_KEYS, read = readChannel, token = githubReleaseToken } = {}) {
  const channel = manifest.version.includes('-') ? 'preview' : 'stable';
  const prior = await read(channel, { fetcher, keys });
  const digest = createHash('sha256').update(signedManifest).digest('hex');
  if (prior && compareVersions(prior.value.version, manifest.version) > 0) throw new Error('A newer release already owns this channel');
  if (prior?.value.version === manifest.version) {
    if (prior.value.releaseManifestSha256 !== digest) throw new Error('Channel contains different bytes for this version');
    return prior.value;
  }
  const value = ChannelIndexSchema.parse({ schemaVersion: 1, channel, revision: (prior?.value.revision ?? 0) + 1,
    version: manifest.version, releaseManifestUrl: `${DISTRIBUTION.repositoryUrl}/releases/download/v${manifest.version}/standalone.json`, releaseManifestSha256: digest });
  const bytes = signReleaseDocument(value, env.RELEASE_SIGNING_KEY_ID, env.RELEASE_SIGNING_KEY, keys);
  const identity = await token(env, fetcher);
  const response = await fetcher(`${DISTRIBUTION.releaseOrigin}/channels/${channel}.json`, { method: 'PUT', body: bytes,
    headers: { Authorization: `Bearer ${identity}`, 'Content-Type': 'application/json',
      ...(prior ? { 'If-Match': prior.etag } : { 'If-None-Match': '*' }) }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(response.status === 412 ? 'Channel changed concurrently; inspect before retrying' : 'Channel activation failed');
  const observed = await read(channel, { fetcher, keys });
  if (!observed || !observed.bytes.equals(bytes)) throw new Error('Public channel activation was not verified');
  return value;
}
