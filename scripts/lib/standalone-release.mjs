import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BundleIdentitySchema, ChannelIndexSchema, RELEASE_PUBLIC_KEYS, StandaloneManifestSchema } from '../../packages/shared/src/standalone.ts';
import { inspectReleaseArchive, sha256File, verifySignedPayload } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
import { DISTRIBUTION } from './product.mjs';

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

export function verifyChannelDocument(bytes, channel, keys = RELEASE_PUBLIC_KEYS) {
  if (bytes.byteLength > 64 * 1024) throw new Error('Channel document is too large');
  const value = ChannelIndexSchema.parse(verifySignedPayload(bytes, keys));
  if (value.channel !== channel || value.releaseManifestUrl !== `${DISTRIBUTION.repositoryUrl}/releases/download/v${value.version}/standalone.json`)
    throw new Error('Standalone channel identity mismatch');
  return value;
}

export async function readChannel(channel, { fetcher = fetch, origin = DISTRIBUTION.releaseOrigin, keys = RELEASE_PUBLIC_KEYS } = {}) {
  if (!['preview', 'stable'].includes(channel)) throw new Error('Unknown release channel');
  // Publication decisions must not reuse a pre-deployment Pages/CDN response.
  const response = await fetcher(`${origin}/channels/${channel}.json?verification=${randomUUID()}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Standalone channel is unavailable');
  const bytes = Buffer.from(await response.arrayBuffer());
  return { value: verifyChannelDocument(bytes, channel, keys), bytes };
}
