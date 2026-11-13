import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { signReleaseDocument, verifyChannelDocument, readChannel } from '../lib/standalone-release.mjs';
import { verifySignedPayload, inspectReleaseArchive, extractReleaseArchive } from '../../apps/server/src/platform/filesystem/release-artifact.ts';
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
  assert.deepEqual(verifyChannelDocument(bytes, 'preview', keys), value);
  const mutated = JSON.parse(bytes); mutated.payload = Buffer.from(JSON.stringify({ ...value, revision: 2 })).toString('base64');
  assert.throws(() => verifySignedPayload(Buffer.from(JSON.stringify(mutated)), keys), /not trusted/);
  assert.throws(() => verifyChannelDocument(Buffer.from(JSON.stringify(mutated)), 'preview', keys), /not trusted/);
  assert.throws(() => verifyChannelDocument(bytes, 'stable', keys), /identity mismatch/);
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

test('static channel discovery verifies signed metadata without requiring write-oriented ETags', async () => {
  const bytes = signed(document());
  const entry = await readChannel('preview', { keys, fetcher: async () => new Response(bytes) });
  assert.deepEqual(entry.value, document());
  assert(entry.bytes.equals(bytes));
  assert.equal(await readChannel('preview', { keys, fetcher: async () => new Response(null, {status:404}) }), null);
  await assert.rejects(readChannel('stable', { keys, fetcher: async () => new Response(bytes) }), /identity mismatch/);
  await assert.rejects(readChannel('preview', { keys, fetcher: async () => new Response(null, {status:503}) }), /unavailable/);
});
