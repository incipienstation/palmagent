import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { deploy, rollback, validateBinding, validateTarget, verifyHealth, verifyInstalled } from '../deploy-staging.mjs';
import { inspectPackage, hashFile } from '../lib/package-artifact.mjs';
import { packageFixture, commit } from './package-fixture.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-staging-test-'));
  const previous = packageFixture(join(root, 'old'), { version: '0.1.0-alpha.0', legacy: true });
  const next = packageFixture(join(root, 'new'));
  const pkgDir = join(root, 'prefix/lib/node_modules/palmagent');
  cpSync(previous.directory, pkgDir, { recursive: true });
  const dataDir = join(root, 'data'); mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'palmagent.db'), 'persistent database');
  const config = { environment: 'staging', domain: 'staging.example.com', pkgDir, dataDir, npmPrefix: join(root, 'prefix') };
  writeFileSync(join(dataDir, 'install.env'), `MODE=package\nRUN_USER=${userInfo().username}\nDOMAIN=${config.domain}\nPKG_DIR=${pkgDir}\nDATA_DIR=${dataDir}\n`);
  const calls = [];
  const call = (command, args) => {
    calls.push([command, args]);
    if (command === 'npm' && args[0] === 'root') return join(root, 'prefix/lib/node_modules');
    if (command === 'npm' && args[0] === 'pack') {
      const filename = 'previous.tgz'; copyFileSync(previous.path, join(args.at(-1), filename));
      return JSON.stringify([{ filename }]);
    }
    if (command === 'npm' && args[0] === 'install') {
      const source = args[4].endsWith('target.tgz') ? next : previous;
      rmSync(pkgDir, { recursive: true }); cpSync(source.directory, pkgDir, { recursive: true });
    }
    return '';
  };
  return { root, previous, next, config, calls, adapters: { call, health: async () => {} }, target: { artifact: next.path, sha256: hashFile(next.path), commit } };
}

test('binding validates installed owner, environment, domain and npm prefix', () => {
  const f = fixture();
  try {
    assert.equal(validateBinding(f.config, f.adapters.call).environment, 'staging');
    assert.throws(() => validateBinding({ ...f.config, environment: 'production' }, f.adapters.call), /staging binding/);
    assert.throws(() => validateBinding({ ...f.config, domain: 'another.example.com' }, f.adapters.call), /domain/);
    assert.throws(() => validateTarget({ version: 'next', commit }), /version/i);
    assert.throws(() => validateTarget({ artifact: f.next.path, commit }), /SHA-256/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('dry run performs no activation; deploy and rollback retain exact bytes and persistent data', async () => {
  const f = fixture();
  try {
    assert.equal((await deploy(f.config, { ...f.target, dryRun: true }, f.adapters)).status, 'validated');
    assert(!existsSync(join(f.config.dataDir, 'deployments')));
    assert(!f.calls.some(([, args]) => args[0] === 'install'));
    const result = await deploy(f.config, f.target, f.adapters);
    assert.equal(result.status, 'succeeded');
    verifyInstalled(f.config, inspectPackage(f.next.path));
    assert(f.calls.some(([, args]) => args[1] === 'update' && !args.includes('--pull')));
    await assert.rejects(rollback(f.config, result.receipt, false, f.adapters), /database-compatible/);
    assert.equal((await rollback(f.config, result.receipt, true, f.adapters)).status, 'rolled-back');
    verifyInstalled(f.config, inspectPackage(f.previous.path, { allowLegacy: true }));
    assert.equal(readFileSync(join(f.config.dataDir, 'palmagent.db'), 'utf8'), 'persistent database');
  } finally { rmSync(f.root, { recursive: true }); }
});

test('wrong checksum, concurrent deployment, failed health and later overlays fail closed', async () => {
  const f = fixture();
  try {
    await assert.rejects(deploy(f.config, { ...f.target, sha256: '0'.repeat(64) }, f.adapters), /checksum/);
    const lock = join(f.config.dataDir, 'deployments/.lock'); mkdirSync(lock, { recursive: true });
    await assert.rejects(deploy(f.config, f.target, f.adapters), /EEXIST/);
    assert(existsSync(lock)); rmSync(lock, { recursive: true });
    await assert.rejects(deploy(f.config, f.target, { ...f.adapters, health: async () => { throw new Error('wrong build'); } }), /failed at activating/);
    assert(!existsSync(lock));
    assert.equal(JSON.parse(readFileSync(join(f.config.pkgDir, 'package.json'))).version, '0.1.0-alpha.1');
    const result = await deploy(f.config, f.target, { ...f.adapters, installed: () => {} });
    writeFileSync(join(f.config.pkgDir, 'server.js'), 'manual overlay');
    await assert.rejects(rollback(f.config, result.receipt, true, f.adapters), /Installed package differs/);
  } finally { rmSync(f.root, { recursive: true }); }
});

test('health verifies the running commit and served shell/script on both origins', async () => {
  const f = fixture();
  try {
    const identity = inspectPackage(f.next.path); const urls = [];
    const request = async (url) => {
      urls.push(url);
      const path = new URL(url).pathname;
      if (path === '/api/health') return Response.json({ ok: true, build: { sourceCommit: commit, version: identity.version, dirty: false } });
      return new Response(f.next.files[path === '/' ? 'web/index.html' : `web${path}`]);
    };
    const config = { ...f.config, localOrigin: 'http://localhost:4100' };
    await verifyHealth(config, identity, request);
    assert.equal(urls.length, 6);
    await assert.rejects(verifyHealth(config, identity, async () => Response.json({ ok: true })), /Running build differs/);
  } finally { rmSync(f.root, { recursive: true }); }
});
