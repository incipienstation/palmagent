import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { channelBranch, readReleaseChannels, stageStandaloneChannel, buildReleasePages,
  assertPagesHead, verifyReleasePages, preflightStandalonePublication } from '../lib/release-pages.mjs';
import { DISTRIBUTION } from '../lib/product.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-pages-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const keys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/develop', RELEASE_ENVIRONMENT: 'standalone-preview',
    RELEASE_SIGNING_KEY_ID: 'test', RELEASE_SIGNING_KEY: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const stable = { ...env, GITHUB_REF: 'refs/heads/main', RELEASE_ENVIRONMENT: 'npm-latest' };
  const blobs = new Map(), trees = new Map(), commits = new Map();
  let head, serial = 0, writes = 0;
  const hooks = {};
  const hash = () => createHash('sha1').update(String(++serial)).digest('hex');
  const api = (path, { method = 'GET', body } = {}) => {
    if (method === 'GET') {
      if (path === 'pages') return { build_type: 'workflow', cname: new URL(DISTRIBUTION.releaseOrigin).hostname, https_enforced: true };
      if (path === `git/matching-refs/heads/${channelBranch}`) return head ? [{ ref: `refs/heads/${channelBranch}`, object: { type: 'commit', sha: head } }] : [];
      if (path.startsWith('git/commits/')) return commits.get(path.split('/').at(-1));
      if (path.startsWith('git/trees/')) return trees.get(path.split('/').at(-1));
      if (path.startsWith('git/blobs/')) return blobs.get(path.split('/').at(-1));
    }
    writes++;
    if (path === 'git/blobs') {
      const sha = hash(), blob = { sha, ...body }; blobs.set(sha, blob); return blob;
    }
    if (path === 'git/trees') {
      const sha = hash(), entries = new Map((trees.get(body.base_tree)?.tree ?? []).map(entry => [entry.path, entry]));
      for (const entry of body.tree) entries.set(entry.path, { ...entry, size: Buffer.from(blobs.get(entry.sha).content, 'base64').length });
      const tree = { sha, tree: [...entries.values()], truncated: false }; trees.set(sha, tree); return tree;
    }
    if (path === 'git/commits') {
      const sha = hash(), commit = { sha, tree: { sha: body.tree }, parents: body.parents };
      commits.set(sha, commit); return commit;
    }
    if (path === 'git/refs' || path === `git/refs/heads/${channelBranch}`) {
      const before = hooks.beforeRef; delete hooks.beforeRef; before?.();
      if (method === 'POST') assert(!head, 'reference already exists');
      else { assert.equal(body.force, false); assert.deepEqual(commits.get(body.sha).parents, [head], 'non-fast-forward'); }
      head = body.sha;
      const after = hooks.afterRef; delete hooks.afterRef; after?.();
      return {};
    }
    assert.fail(`Unexpected API call: ${method} ${path}`);
  };
  const stage = (version, bytes = Buffer.from(version)) => stageStandaloneChannel({ version }, bytes, version.includes('-') ? env : stable, { api, keys });
  return { root, keys, env, stable, api, stage, hooks, blobs, trees, commits, writes: () => writes,
    state: () => readReleaseChannels(api, keys), clearHead: () => { head = undefined; } };
}

test('channel journal preserves both channels and retry bytes, and rejects regressions or changed releases', t => {
  const f = fixture(t);
  assert.equal(f.state().commit, null);
  f.stage('0.2.0-alpha.1');
  const preview = f.state().channels.preview.bytes;
  f.stage('0.2.0');
  assert(f.state().channels.preview.bytes.equals(preview));
  const stable = f.state().channels.stable.bytes;
  const writes = f.writes(), same = f.stage('0.2.0-alpha.1');
  assert.equal(f.writes(), writes);
  assert.equal(same.commit, f.state().commit);
  f.stage('0.2.0-alpha.2');
  assert(f.state().channels.stable.bytes.equals(stable));
  assert.equal(f.state().channels.preview.value.revision, 2);
  assert.throws(() => f.stage('0.2.0-alpha.1'), /newer release/);
  assert.throws(() => f.stage('0.2.0-alpha.2', Buffer.from('different')), /different bytes/);
  assert.throws(() => stageStandaloneChannel({version:'0.2.0-alpha.3'}, Buffer.from('x'), f.stable, f), /protected release/);
  assert.throws(() => stageStandaloneChannel({version:'0.2.0'}, Buffer.from('x'), f.env, f), /protected release/);
});

test('a competing publisher cannot be overwritten, including first publication', t => {
  const f = fixture(t);
  f.hooks.beforeRef = () => f.stage('0.2.0');
  assert.throws(() => f.stage('0.2.0-alpha.1'), /already exists/);
  assert.deepEqual(Object.keys(f.state().channels), ['stable']);
  f.stage('0.2.0-alpha.1');
  f.hooks.beforeRef = () => f.stage('0.2.0-alpha.3');
  assert.throws(() => f.stage('0.2.0-alpha.2'), /non-fast-forward/);
  assert.equal(f.state().channels.preview.value.version, '0.2.0-alpha.3');
  assert.equal(f.state().channels.stable.value.version, '0.2.0');
});

test('a lost ref-write response is reconciled without a second signed revision', t => {
  const f = fixture(t);
  f.hooks.afterRef = () => { throw new Error('connection lost after write'); };
  const result = f.stage('0.2.0-alpha.1');
  assert.equal(result.commit, f.state().commit);
  assert.equal(f.state().channels.preview.value.revision, 1);
  const writes = f.writes(); f.stage('0.2.0-alpha.1'); assert.equal(f.writes(), writes);
});

test('Pages build copies only signed channel files and rejects corrupt or unexpected journal contents', t => {
  const f = fixture(t);
  const empty = join(f.root, 'empty'), bootstrap = buildReleasePages(empty, f.env, f);
  assert.equal(bootstrap.channelCommit, null);
  assert.match(readFileSync(join(empty, 'install.sh'), 'utf8'), /test/);
  assertPagesHead(empty, f.env, f);
  f.stage('0.2.0-alpha.1');
  assert.throws(() => assertPagesHead(empty, f.env, f), /advanced/);
  const site = join(f.root, 'published');
  buildReleasePages(site, f.env, { ...f, expectedCommit: f.state().commit });
  assert(readFileSync(join(site, 'channels/preview.json')).equals(f.state().channels.preview.bytes));
  assert.throws(() => buildReleasePages(site, f.env, f), /must be empty/);
  const tree = f.trees.get(f.state().tree);
  tree.tree.push({ ...tree.tree[0], path: 'private.txt' });
  assert.throws(() => f.state(), /Unexpected/);
  tree.tree.pop();
  const blob = f.blobs.get(tree.tree[0].sha);
  const signed = JSON.parse(Buffer.from(blob.content, 'base64'));
  signed.signatures[0].signature = Buffer.alloc(64).toString('base64');
  const corrupted = Buffer.from(JSON.stringify(signed));
  blob.content = corrupted.toString('base64'); tree.tree[0].size = corrupted.length;
  assert.throws(() => f.state(), /not trusted/);
});

test('preflight requires configured HTTPS, deployed trust keys and recoverable channel history', async t => {
  const f = fixture(t), site = join(f.root, 'site');
  f.stage('0.2.0-alpha.1');
  const health = buildReleasePages(site, f.env, f);
  const read = async channel => f.state().channels[channel] ?? null;
  const adapters = { ...f, read, fetcher: async () => Response.json(health) };
  const preflight = () => preflightStandalonePublication({}, Buffer.alloc(0), f.env, adapters);
  assert.equal((await preflight()).commit, f.state().commit);
  const api = adapters.api;
  adapters.api = (path, options) => path === 'pages' ? { ...api(path, options), https_enforced: false } : api(path, options);
  await assert.rejects(preflight(), /enforced HTTPS/);
  adapters.api = api;
  adapters.fetcher = async () => Response.json({ ...health, trustSha256: 'wrong' });
  await assert.rejects(preflight(), /different trust keys/);
  adapters.fetcher = async () => Response.json(health);
  const published = f.state().channels.preview; f.clearHead();
  adapters.read = async channel => channel === 'preview' ? published : null;
  await assert.rejects(preflight(), /ahead of its journal/);
});

test('Pages readback waits for all exact files and does not report a failed deployment as published', async t => {
  const f = fixture(t), site = join(f.root, 'site');
  f.stage('0.2.0-alpha.1'); buildReleasePages(site, f.env, f);
  let iteration = 0;
  const fetcher = async url => {
    const path = new URL(url).pathname.slice(1);
    if (path === 'channels/stable.json') return new Response(null, { status:404 });
    const bytes = readFileSync(join(site, path));
    return new Response(iteration === 0 && path === 'install.sh' ? 'stale installer' : bytes);
  };
  await verifyReleasePages(site, { fetcher, attempts:2, sleep:async () => { iteration++; } });
  assert.equal(iteration, 1);
  await assert.rejects(verifyReleasePages(site, {
    attempts:1, fetcher:async () => new Response('wrong'),
  }), /Public Pages readback did not match/);
  await assert.rejects(verifyReleasePages(site, {
    attempts:1, fetcher:async () => { throw new Error('network unavailable'); },
  }), /Public Pages readback did not match/);
});

test('publication and Pages recovery share serialization and retain the single Stable environment gate', () => {
  const publication = readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('../../.github/workflows/release-pages.yml', import.meta.url), 'utf8');
  for (const workflow of [publication, recovery]) {
    assert.match(workflow, /group: release-pages-publication/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /pages: write/);
    assert.match(workflow, /id-token: write/);
    assert(workflow.indexOf('release-pages.mjs check') < workflow.indexOf('actions/deploy-pages@'));
    assert(workflow.indexOf('actions/deploy-pages@') < workflow.indexOf('release-pages.mjs verify'));
  }
  assert.match(publication, /environment: \$\{\{ needs\.candidate\.outputs\.channel == 'next' && 'standalone-preview' \|\| 'npm-latest' \}\}/);
  assert(!recovery.includes('RELEASE_SIGNING_KEY'));
});
