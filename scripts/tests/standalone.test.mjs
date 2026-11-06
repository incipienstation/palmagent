import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { signReleaseDocument, publishStandaloneChannel } from '../lib/standalone-release.mjs';
import { verifySignedPayload, inspectReleaseArchive, extractReleaseArchive } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
import { handleReleaseRequest, verifyChannelDocument, authorizePublisher } from '../../deploy/releases/worker.mjs';
import { ChannelIndexSchema, versionAtLeast } from '../../packages/shared/src/standalone.ts';
import { DISTRIBUTION } from '../lib/product.mjs';

const pair = generateKeyPairSync('ed25519');
const keys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
const secret = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const document = (version = '0.2.0-alpha.1', revision = 1) => ({ schemaVersion: 1, channel: 'preview', revision, version,
  releaseManifestUrl: `${DISTRIBUTION.repositoryUrl}/releases/download/v${version}/standalone.json`, releaseManifestSha256: 'a'.repeat(64) });
const signed = value => signReleaseDocument(value, 'test', secret, keys);

test('release signatures authenticate exact payload bytes and reject unknown keys and mutations', async () => {
  const value = document(), bytes = signed(value);
  assert.deepEqual(verifySignedPayload(bytes, keys), value);
  assert.deepEqual(await verifyChannelDocument(bytes, keys), value);
  const mutated = JSON.parse(bytes); mutated.payload = Buffer.from(JSON.stringify({ ...value, revision: 2 })).toString('base64');
  assert.throws(() => verifySignedPayload(Buffer.from(JSON.stringify(mutated)), keys), /not trusted/);
  await assert.rejects(verifyChannelDocument(Buffer.from(JSON.stringify(mutated)), keys), /Untrusted/);
  assert.throws(() => verifySignedPayload(bytes, {}), /not trusted/);
  assert.throws(() => signReleaseDocument(value, 'missing', secret, keys), /not configured/);
  assert.throws(() => signReleaseDocument(value, 'test', generateKeyPairSync('ed25519').privateKey.export({ type:'pkcs8', format:'pem' }), keys), /does not match/);
  assert.equal(versionAtLeast('2.9', '2.35'), false);
  assert.equal(versionAtLeast('2.35', '2.35'), true);
  assert.equal(ChannelIndexSchema.safeParse({ ...value, channel: 'stable' }).success, false);
});

test('archives reject links, traversal, unexpected roots, duplicates and expanded-size violations', t => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-archive-test-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  mkdirSync(join(root, 'palmagent/runtime/bin'), {recursive:true}); mkdirSync(join(root, 'palmagent/app'));
  for (const name of ['runtime/bin/node', 'app/package.json', 'bundle.json']) writeFileSync(join(root, 'palmagent', name), '');
  writeFileSync(join(root, 'palmagent/file'), 'content');
  const archive = join(root, 'bundle.tar.gz');
  const pack = (...entries) => execFileSync('tar', ['--hard-dereference', '-czf', archive, '-C', root, ...entries]);
  pack('palmagent'); inspectReleaseArchive(archive, statSync(archive).size, 7);
  const out = join(root, 'out'); mkdirSync(out); extractReleaseArchive(archive, out, statSync(archive).size, 7);
  assert.equal(readFileSync(join(out, 'palmagent/file'), 'utf8'), 'content');
  assert.throws(() => inspectReleaseArchive(archive, statSync(archive).size, 6), /size|limit/);
  assert.throws(() => inspectReleaseArchive(archive, statSync(archive).size + 1, 7), /size/);
  symlinkSync('/etc/passwd', join(root, 'palmagent/link')); pack('palmagent');
  assert.throws(() => inspectReleaseArchive(archive, statSync(archive).size, 99), /Unsafe/);
  rmSync(join(root, 'palmagent/link'));
  pack('palmagent/file', 'palmagent/file'); assert.throws(() => inspectReleaseArchive(archive, statSync(archive).size, 99), /duplicate|path/i);
  execFileSync('tar', ['-czf', archive, '-C', root, '--transform=s|palmagent|../outside|', 'palmagent/file']);
  assert.throws(() => inspectReleaseArchive(archive, statSync(archive).size, 99), /Unsafe/);
});

function storage() {
  let stored;
  return {
    get: async () => stored ? { body: stored.bytes, httpEtag: stored.etag, arrayBuffer: async () => stored.bytes } : null,
    put: async (key, bytes, options) => {
      const headers = options.onlyIf;
      if (stored ? headers.get('if-match') !== stored.etag : headers.get('if-none-match') !== '*') return null;
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      stored = { bytes, etag }; return { httpEtag: etag };
    },
  };
}
test('channel activation requires authorization and an atomic revision/ETag advance', async () => {
  const env = { RELEASE_INDEX: storage() };
  const options = { authorize: async () => {}, verifyDocument: bytes => verifyChannelDocument(bytes, keys) };
  const request = (value, headers = {}, method = 'PUT') => new Request(`${DISTRIBUTION.releaseOrigin}/channels/preview.json`, { method, body: signed(value), headers });
  assert.equal((await handleReleaseRequest(request(document(), {'If-None-Match':'*'}), env)).status, 403);
  assert.equal((await handleReleaseRequest(request(document()), env, options)).status, 412);
  assert.equal((await handleReleaseRequest(request(document(), {}, 'POST'), env, options)).status, 204);
  assert.equal(await env.RELEASE_INDEX.get('ignored'), null);
  assert.equal((await handleReleaseRequest(request(document(), {'If-None-Match':'*'}), env, options)).status, 204);
  const prior = await handleReleaseRequest(new Request(`${DISTRIBUTION.releaseOrigin}/channels/preview.json`), env, options);
  assert.equal(prior.headers.get('cache-control'), 'no-store');
  const headers = { 'If-Match': prior.headers.get('etag') };
  const results = await Promise.all(['0.2.0-alpha.2', '0.2.0-alpha.3'].map(version => handleReleaseRequest(request(document(version, 2), headers), env, options)));
  assert.deepEqual(results.map(r => r.status).sort(), [204, 412]);
  const latest = await env.RELEASE_INDEX.get('ignored');
  assert.equal((await handleReleaseRequest(request(document('0.2.0-alpha.1', 3), { 'If-Match': latest.httpEtag }), env, options)).status, 409);
});

test('publisher retains immutable signed bytes, verifies public readback, and never regresses a channel', async () => {
  const env = { RELEASE_SIGNING_KEY_ID:'test', RELEASE_SIGNING_KEY:secret };
  let state, writes = 0;
  const manifest = { version:'0.2.0-alpha.1' }, bytes = signed({ version:manifest.version });
  const adapters = { keys, read: async () => state, token: async () => 'ephemeral', fetcher: async (url, options) => {
    writes++; assert.equal(options.headers['If-None-Match'], '*');
    state = { value:verifySignedPayload(options.body, keys), bytes:options.body, etag:'"first"' }; return new Response(null, {status:204});
  } };
  await publishStandaloneChannel(manifest, bytes, env, adapters);
  await publishStandaloneChannel(manifest, bytes, env, adapters); assert.equal(writes, 1);
  await assert.rejects(publishStandaloneChannel(manifest, signed({changed:true}), env, adapters), /different bytes/);
  await assert.rejects(publishStandaloneChannel({version:'0.1.0-alpha.1'}, bytes, env, adapters), /newer release/);
  await assert.rejects(authorizePublisher(new Request(DISTRIBUTION.releaseOrigin), 'preview', {REPOSITORY_ID:'1'}), /identity required/);
});

test('OIDC authorization binds the repository, branch, workflow, environment and audience', async () => {
  const { sign } = await import('node:crypto');
  const pair = generateKeyPairSync('rsa', { modulusLength:2048 });
  const jwk = { ...pair.publicKey.export({format:'jwk'}), kid:'test', use:'sig' };
  const now = Date.now(), seconds = Math.floor(now / 1000), repository = DISTRIBUTION.repositoryUrl.replace('https://github.com/', '');
  const claims = { iss:'https://token.actions.githubusercontent.com', aud:DISTRIBUTION.releaseOrigin, repository, repository_id:'123',
    ref:'refs/heads/develop', sub:`repo:${repository}:environment:standalone-preview`,
    workflow_ref:`${repository}/.github/workflows/npm-publish.yml@refs/heads/develop`, nbf:seconds-5, iat:seconds-5, exp:seconds+295 };
  const request = overrides => {
    const body = [Buffer.from(JSON.stringify({alg:'RS256', kid:'test'})).toString('base64url'), Buffer.from(JSON.stringify({...claims,...overrides})).toString('base64url')].join('.');
    return new Request(DISTRIBUTION.releaseOrigin, {headers:{Authorization:`Bearer ${body}.${sign('RSA-SHA256',Buffer.from(body),pair.privateKey).toString('base64url')}`}});
  };
  const fetcher = async () => Response.json({keys:[jwk]});
  await authorizePublisher(request({}), 'preview', {REPOSITORY_ID:'123'}, fetcher, now);
  for (const change of [{aud:'other'}, {repository_id:'456'}, {ref:'refs/heads/main'}, {sub:`repo:${repository}:environment:npm-next`},
    {workflow_ref:`${repository}/.github/workflows/other.yml@refs/heads/develop`}, {exp:seconds-1}]) {
    await assert.rejects(authorizePublisher(request(change), 'preview', {REPOSITORY_ID:'123'}, fetcher, now), /not authorized/);
  }
});
