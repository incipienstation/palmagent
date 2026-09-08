import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { deploy, rollback, validateBinding, validateTarget, verifyHealth, verifyInstalled } from '../deploy-staging.mjs';
import { inspectPackage, hashFile } from '../lib/package-artifact.mjs';
import { packageFixture, commit } from './package-fixture.mjs';

function fixture({ realNpm = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-staging-test-'));
  const previous = packageFixture(join(root, 'old'), { version: '0.1.0-alpha.0', legacy: !realNpm, sourceCommit: 'b'.repeat(40) });
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
    if (realNpm && command === 'npm') return execFileSync(command, args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
    });
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

for (const phase of ['activation', 'health']) test(`rollback resumes after ${phase} failure without reinstalling or losing failure evidence`, async () => {
  const f = fixture({ realNpm: true });
  try {
    const result = await deploy(f.config, f.target, f.adapters);
    const failedAdapters = {
      ...f.adapters,
      call: (command, args) => {
        if (phase === 'activation' && command === process.execPath) throw new Error('activation unavailable');
        return f.adapters.call(command, args);
      },
      health: async () => { if (phase === 'health') throw new Error('health unavailable'); },
    };
    await assert.rejects(rollback(f.config, result.receipt, true, failedAdapters), /unavailable/);
    verifyInstalled(f.config, inspectPackage(f.previous.path));
    await assert.rejects(rollback(f.config, result.receipt, true, failedAdapters), /unavailable/);
    const failed = readFileSync(result.receipt, 'utf8');
    assert.equal(JSON.parse(failed).rollback.failedAt, 'activating');
    assert.equal(JSON.parse(failed).rollback.failures.length, 2);
    const installs = f.calls.filter(([command, args]) => command === 'npm' && args[0] === 'install').length;

    // A blocked retry must neither overwrite an overlay nor erase the original failure.
    writeFileSync(join(f.config.pkgDir, 'server.js'), 'manual overlay');
    await assert.rejects(rollback(f.config, result.receipt, true, f.adapters), /Installed package differs/);
    assert.equal(readFileSync(result.receipt, 'utf8'), failed);
    writeFileSync(join(f.config.pkgDir, 'server.js'), f.previous.files['server.js']);

    assert.equal((await rollback(f.config, result.receipt, true, f.adapters)).status, 'rolled-back');
    assert.equal(f.calls.filter(([command, args]) => command === 'npm' && args[0] === 'install').length, installs);
    const receipt = JSON.parse(readFileSync(result.receipt));
    assert.equal(receipt.rollback.status, 'succeeded');
    assert.equal(receipt.rollback.failures[0].phase, 'activating');
    assert.equal(JSON.parse(readFileSync(join(f.config.dataDir, 'deployments/current.json'))).rollback, true);
    assert.equal(readFileSync(join(f.config.dataDir, 'palmagent.db'), 'utf8'), 'persistent database');
  } finally { rmSync(f.root, { recursive: true }); }
});

for (const laterFails of [false, true]) test(`rollback retry refuses a later ${laterFails ? 'failed' : 'successful'} deployment of identical previous bytes`, async () => {
  const f = fixture({ realNpm: true });
  try {
    const result = await deploy(f.config, f.target, f.adapters);
    await assert.rejects(rollback(f.config, result.receipt, true, {
      ...f.adapters, health: async () => { throw new Error('health unavailable'); },
    }), /unavailable/);
    const failed = readFileSync(result.receipt, 'utf8');
    const later = deploy(f.config, { artifact: f.previous.path, sha256: hashFile(f.previous.path), commit: 'b'.repeat(40) }, {
      ...f.adapters, health: async () => { if (laterFails) throw new Error('health unavailable'); },
    });
    if (laterFails) await assert.rejects(later, /failed at activating/);
    else await later;
    verifyInstalled(f.config, inspectPackage(f.previous.path));
    await assert.rejects(rollback(f.config, result.receipt, true, f.adapters), /later deployment operation/);
    assert.equal(readFileSync(result.receipt, 'utf8'), failed);
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
