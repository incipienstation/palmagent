import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChannelIndexSchema, RELEASE_PUBLIC_KEYS } from '../../packages/shared/src/standalone.ts';
import { DISTRIBUTION } from './product.mjs';
import { github, delay } from './release-github.mjs';
import { compareVersions } from './release-version.mjs';
import { readChannel, signReleaseDocument, verifyChannelDocument } from './standalone-release.mjs';
import { renderInstaller } from '../render-installer.mjs';

export const channelBranch = 'release-channels';
const channels = ['preview', 'stable'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const commitId = value => /^[a-f0-9]{40}$/.test(value ?? '');
const apiFor = env => (path, options) => github(env.GH_REPO, path, options);
const trustHash = keys => sha256(JSON.stringify(Object.fromEntries(Object.keys(keys).sort().map(key => [key, keys[key]]))));

// The data branch is the publication journal. Read it through GitHub's API,
// never a cached public channel, and preserve the exact signed bytes on retries.
export function readReleaseChannels(api, keys = RELEASE_PUBLIC_KEYS) {
  const refs = api(`git/matching-refs/heads/${channelBranch}`);
  assert(Array.isArray(refs), 'Invalid channel branch inventory');
  const matches = refs.filter(ref => ref.ref === `refs/heads/${channelBranch}`);
  assert(matches.length <= 1, 'Ambiguous channel branch');
  if (!matches.length) return { commit: null, tree: null, channels: {} };
  const ref = matches[0];
  assert(ref.object?.type === 'commit' && commitId(ref.object.sha), 'Invalid channel branch identity');
  const commit = api(`git/commits/${ref.object.sha}`);
  assert(commit.sha === ref.object.sha && commitId(commit.tree?.sha), 'Channel commit identity differs');
  const tree = api(`git/trees/${commit.tree.sha}`);
  assert(tree.sha === commit.tree.sha && !tree.truncated && Array.isArray(tree.tree), 'Invalid channel tree');
  const entries = {};
  for (const entry of tree.tree) {
    const channel = channels.find(name => entry.path === `${name}.json`);
    assert(channel && !entries[channel] && entry.type === 'blob' && entry.mode === '100644'
      && commitId(entry.sha) && entry.size > 0 && entry.size <= 64 * 1024, 'Unexpected channel branch content');
    const blob = api(`git/blobs/${entry.sha}`);
    assert(blob.sha === entry.sha && blob.encoding === 'base64' && typeof blob.content === 'string', 'Invalid channel blob');
    const bytes = Buffer.from(blob.content, 'base64');
    assert(bytes.length === entry.size, 'Channel blob size differs');
    entries[channel] = { value: verifyChannelDocument(bytes, channel, keys), bytes };
  }
  assert(Object.keys(entries).length > 0, 'Channel branch must not be empty');
  return { commit: commit.sha, tree: tree.sha, channels: entries };
}

export async function preflightStandalonePublication(manifest, signedManifest, env, {
  api = apiFor(env), fetcher = fetch, keys = RELEASE_PUBLIC_KEYS, read = readChannel,
} = {}) {
  const site = api('pages');
  assert(site.build_type === 'workflow' && site.cname === new URL(DISTRIBUTION.releaseOrigin).hostname && site.https_enforced === true,
    'Configure GitHub Pages, the release custom domain and enforced HTTPS before publishing');
  const response = await fetcher(`${DISTRIBUTION.releaseOrigin}/health?preflight=${randomUUID()}`, {
    cache: 'no-store', signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Deploy the release Pages site before publishing');
  const health = await response.json();
  assert(health.schemaVersion === 1 && health.hosting === 'github-pages' && health.trustSha256 === trustHash(keys),
    'The deployed release site has different trust keys; redeploy Pages before publishing');
  const state = readReleaseChannels(api, keys);
  // Losing the journal must not silently reset a channel's history or erase
  // the other channel from the next full-site deployment.
  for (const channel of channels) {
    const published = await read(channel, { fetcher, keys });
    const staged = state.channels[channel];
    if (!published) continue;
    assert(staged && compareVersions(staged.value.version, published.value.version) >= 0,
      'Public channel is ahead of its journal; restore the channel branch before publishing');
    assert(staged.value.version !== published.value.version || staged.bytes.equals(published.bytes),
      'Public channel bytes differ from their journal');
  }
  return state;
}

export function stageStandaloneChannel(manifest, signedManifest, env, {
  api = apiFor(env), keys = RELEASE_PUBLIC_KEYS,
} = {}) {
  const channel = manifest.version.includes('-') ? 'preview' : 'stable';
  assert(env.GITHUB_ACTIONS === 'true'
    && env.GITHUB_REF === `refs/heads/${channel === 'preview' ? 'develop' : 'main'}`
    && env.RELEASE_ENVIRONMENT === (channel === 'preview' ? 'standalone-preview' : 'npm-latest'),
  'Channel writes require the protected release Actions job');
  const state = readReleaseChannels(api, keys);
  const prior = state.channels[channel];
  const digest = sha256(signedManifest);
  assert(!prior || compareVersions(prior.value.version, manifest.version) <= 0, 'A newer release already owns this channel');
  if (prior?.value.version === manifest.version) {
    assert(prior.value.releaseManifestSha256 === digest, 'Channel contains different bytes for this version');
    return { commit: state.commit, value: prior.value };
  }
  const value = ChannelIndexSchema.parse({ schemaVersion: 1, channel, revision: (prior?.value.revision ?? 0) + 1,
    version: manifest.version, releaseManifestUrl: `${DISTRIBUTION.repositoryUrl}/releases/download/v${manifest.version}/standalone.json`,
    releaseManifestSha256: digest });
  const bytes = signReleaseDocument(value, env.RELEASE_SIGNING_KEY_ID, env.RELEASE_SIGNING_KEY, keys);
  const blob = api('git/blobs', { method: 'POST', body: { content: bytes.toString('base64'), encoding: 'base64' } });
  assert(commitId(blob.sha), 'Invalid new channel blob');
  const tree = api('git/trees', { method: 'POST', body: {
    ...(state.tree ? { base_tree: state.tree } : {}),
    tree: [{ path: `${channel}.json`, mode: '100644', type: 'blob', sha: blob.sha }],
  } });
  assert(commitId(tree.sha), 'Invalid new channel tree');
  const commit = api('git/commits', { method: 'POST', body: {
    message: `chore(release): advance ${channel} to ${manifest.version}`,
    tree: tree.sha, parents: state.commit ? [state.commit] : [],
  } });
  assert(commitId(commit.sha), 'Invalid new channel commit');
  try {
    if (state.commit) {
      // A sibling commit based on an out-of-date parent cannot fast-forward
      // this ref. Never force-push over another publisher's channel update.
      api(`git/refs/heads/${channelBranch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
    } else {
      api('git/refs', { method: 'POST', body: { ref: `refs/heads/${channelBranch}`, sha: commit.sha } });
    }
  } catch (error) {
    // A lost response can follow a successful write. Reconcile instead of
    // creating a second revision or repeating an uncertain mutation.
    if (readReleaseChannels(api, keys).commit !== commit.sha) throw error;
  }
  assert(readReleaseChannels(api, keys).commit === commit.sha, 'Channel changed concurrently; inspect before retrying');
  return { commit: commit.sha, value };
}

export function buildReleasePages(directory, env, {
  api = apiFor(env), keys = RELEASE_PUBLIC_KEYS, expectedCommit,
} = {}) {
  const state = readReleaseChannels(api, keys);
  if (expectedCommit !== undefined) assert(commitId(expectedCommit) && state.commit === expectedCommit, 'Channel branch advanced before Pages build');
  mkdirSync(directory, { recursive: true });
  assert(readdirSync(directory).length === 0, 'Pages output directory must be empty');
  const installer = Buffer.from(renderInstaller({ trust: { schemaVersion: 1, keys } }));
  const health = { schemaVersion: 1, hosting: 'github-pages', channelCommit: state.commit,
    trustSha256: trustHash(keys), installerSha256: sha256(installer) };
  writeFileSync(join(directory, 'health'), JSON.stringify(health) + '\n');
  writeFileSync(join(directory, 'install.sh'), installer, { mode: 0o755 });
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
    + '<title>Palmagent releases</title><h1>Palmagent releases</h1><p><a href="install.sh">Installation script</a></p>'
    + `<p><a href="${DISTRIBUTION.repositoryUrl}/releases">Downloads and release notes</a></p></html>\n`);
  mkdirSync(join(directory, 'channels'));
  for (const [channel, entry] of Object.entries(state.channels)) writeFileSync(join(directory, 'channels', `${channel}.json`), entry.bytes);
  return health;
}

export function assertPagesHead(directory, env, { api = apiFor(env), keys = RELEASE_PUBLIC_KEYS } = {}) {
  const expected = JSON.parse(readFileSync(join(directory, 'health'), 'utf8'));
  const state = readReleaseChannels(api, keys);
  assert(state.commit === expected.channelCommit, 'Channel branch advanced; rebuild the Pages artifact');
  assert(expected.trustSha256 === trustHash(keys), 'Pages artifact trust keys differ');
}

// Pages/CDN activation is asynchronous. A successful deploy action alone does
// not establish that the installer and both channel files are publicly usable.
export async function verifyReleasePages(directory, {
  fetcher = fetch, sleep = delay, attempts = 60, intervalMs = 10_000, origin = DISTRIBUTION.releaseOrigin,
} = {}) {
  const expected = new Map(['health', 'install.sh'].map(path => [path, readFileSync(join(directory, path))]));
  const present = new Set(readdirSync(join(directory, 'channels')));
  for (const channel of channels) {
    const path = `channels/${channel}.json`;
    expected.set(path, present.has(`${channel}.json`) ? readFileSync(join(directory, path)) : null);
  }
  let pending = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    pending = [];
    for (const [path, bytes] of expected) {
      try {
        const response = await fetcher(`${origin}/${path}?verification=${randomUUID()}`, {
          cache: 'no-store', signal: AbortSignal.timeout(15_000),
        });
        if (bytes === null) {
          if (response.status !== 404) pending.push(path);
        } else if (!response.ok || !Buffer.from(await response.arrayBuffer()).equals(bytes)) pending.push(path);
      } catch { pending.push(path); }
    }
    if (!pending.length) return;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error(`Public Pages readback did not match the deployed artifact: ${pending.join(', ')}`);
}
