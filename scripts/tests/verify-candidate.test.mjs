import assert from 'node:assert/strict';
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contractFiles } from '../../apps/server/scripts/run-contracts.mjs';
import { candidatePlan, verifyCandidate, canDistributeCandidate, candidateLane, candidateLaneNames, canSplitServerContracts, serverLane, requireCandidateChecks } from '../verify-candidate.mjs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const webManifest = JSON.parse(readFileSync('apps/web/package.json', 'utf8'));
const serverManifest = JSON.parse(readFileSync('apps/server/package.json', 'utf8'));
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-candidate-gate-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(manifest));
  return cwd;
}

test('parallel plan retains every source check exactly once', () => {
  const plan = candidatePlan(manifest);
  const actual = [...plan.before, ...plan.lanes.flat()].map(step => `pnpm ${step.args[0]}`);
  assert.deepEqual(actual.sort(), manifest.scripts.verify.split('&&').map(value => value.trim()).sort());
});

test('distributed verification covers all four browser shards and the service worker once', () => {
  assert.equal(canDistributeCandidate(manifest, webManifest), true);
  const workflow = readFileSync('.github/workflows/release-candidate.yml', 'utf8');
  assert.match(workflow, /lane: \$\{\{ fromJSON\(needs\.prepare\.outputs\.lanes\) \}\}/);
  const names = candidateLaneNames(manifest, serverManifest);
  assert.deepEqual(names, ['tooling', 'server-native', 'server-node', 'web-1', 'web-2', 'web-3', 'web-4', 'sw']);
  const lanes = names.map(candidateLane);
  assert.deepEqual(lanes.flat().filter(s => s.command === 'pnpm').map(s => s.args[0]),
    ['typecheck', 'pkg:check', 'server:contracts:native', 'server:contracts:node', 'server:smoke']);
  assert.deepEqual(lanes.flat().filter(s => s.command !== 'pnpm').map(s => s.args), [
    ['apps/web/scripts/run-e2e.mjs', '--shard=1/4'],
    ['apps/web/scripts/run-e2e.mjs', '--shard=2/4'],
    ['apps/web/scripts/run-e2e.mjs', '--shard=3/4'],
    ['apps/web/scripts/run-e2e.mjs', '--shard=4/4'],
    ['apps/web/scripts/test-sw-update.mjs'],
  ]);
  for (const name of ['', 'web-5', 'constructor', '__proto__']) assert.throws(() => candidateLane(name));
});

test('split server lanes cover each contract file once and preserve the combined gate for older or changed sources', () => {
  assert.equal(canSplitServerContracts(manifest, serverManifest), true);
  const cwd = 'apps/server';
  const native = contractFiles('native', cwd), node = contractFiles('node', cwd);
  assert.deepEqual([...native, ...node].sort(), [...globSync(['tests/**/*.test.ts', 'tests/**/*.test.mjs'], { cwd })].sort());
  assert(native.every(path => !node.includes(path)));
  assert(native.includes('tests/integration/native-script-runtime.test.ts'));
  assert.throws(() => contractFiles('unknown', cwd), /Expected/);
  assert.throws(() => contractFiles('native', 'scripts/tests'), /Missing native/);
  const original = structuredClone(manifest);
  delete original.scripts['server:contracts:native']; delete original.scripts['server:contracts:node'];
  const combined = ['tooling', 'server', 'web-1', 'web-2', 'web-3', 'web-4', 'sw'];
  assert.deepEqual(candidateLaneNames(original, serverManifest), combined);
  assert.deepEqual(serverLane(original, serverManifest, 'native'), candidateLane('server'));
  assert.deepEqual(serverLane(original, serverManifest, 'node'), []);
  assert.deepEqual(serverLane(manifest, serverManifest, 'node'), candidateLane('server-node'));
  assert.throws(() => serverLane(manifest, serverManifest, 'unknown'), /Unknown/);
  assert.deepEqual(candidateLaneNames(manifest, undefined), combined);
  for (const [which, name] of [['root', 'server:contracts'], ['root', 'server:contracts:native'], ['root', 'server:contracts:node'],
    ['server', 'contracts'], ['server', 'contracts:native'], ['server', 'contracts:node']]) {
    for (const hook of [false, true]) {
      const root = structuredClone(manifest), server = structuredClone(serverManifest);
      const scripts = (which === 'root' ? root : server).scripts;
      if (hook) scripts[`post${name}`] = 'node extra-check.mjs';
      else scripts[name] += ' && node extra-check.mjs';
      assert.deepEqual(candidateLaneNames(root, server), combined);
    }
  }
});

test('browser gate additions and build lifecycle hooks keep the complete source fallback', () => {
  for (const name of ['verify', 'web:build', 'web:verify', 'web:verify:built']) {
    const changed = structuredClone(manifest);
    changed.scripts[name] += ' && node extra-check.mjs';
    assert.equal(canDistributeCandidate(changed, webManifest), false, name);
  }
  for (const name of ['verify', 'typecheck', 'web:build', 'web:verify', 'web:verify:built']) {
    for (const prefix of ['pre', 'post']) {
      const changed = structuredClone(manifest);
      changed.scripts[prefix + name] = 'node lifecycle.mjs';
      assert.equal(canDistributeCandidate(changed, webManifest), false, prefix + name);
    }
  }
  for (const scripts of [{}, { build: 'vite build && node extra-check.mjs' },
    { ...webManifest.scripts, prebuild: 'node setup.mjs' }, { ...webManifest.scripts, postbuild: 'node check.mjs' }]) {
    assert.equal(canDistributeCandidate(manifest, { scripts }), false);
  }
});

test('candidate packaging rejects failed, cancelled, missing or skipped required verification', () => {
  const results = (reuse, distributed, result) => ({
    prepare: { result: 'success', outputs: { reuse, distributed } }, verify: { result },
  });
  requireCandidateChecks(results('false', 'true', 'success'));
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.throws(() => requireCandidateChecks(results('false', 'true', result)));
  }
  for (const [reuse, distributed] of [['true', 'true'], ['true', 'false'], ['false', 'false']]) {
    requireCandidateChecks(results(reuse, distributed, 'skipped'));
    assert.throws(() => requireCandidateChecks(results(reuse, distributed, 'failure')));
  }
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    const value = results('false', 'true', 'success'); value.prepare.result = result;
    assert.throws(() => requireCandidateChecks(value));
  }
  for (const value of [undefined, {}, results(undefined, 'true', 'success'), results('false', true, 'success')]) {
    assert.throws(() => requireCandidateChecks(value));
  }
});

test('changed, missing and hooked source gates fall back to the source full verification', () => {
  for (const scripts of [undefined, { verify: 'pnpm additional-check && ' + manifest.scripts.verify },
    { ...manifest.scripts, preverify: 'node prepare.mjs' },
    { ...manifest.scripts, 'postweb:verify': 'node check.mjs' }]) {
    const plan = candidatePlan({ scripts });
    assert.deepEqual(plan.before.map(step => step.args), [['verify']]);
    assert.deepEqual(plan.lanes, []);
  }
});

test('metadata must pass before parallel lanes start, and all lanes must finish', async (t) => {
  let metadata = false;
  const started = [], release = [];
  const pending = verifyCandidate(fixture(t), { report() {}, run: async steps => {
    if (steps[0].id === 'plugins-check') { metadata = true; return 0; }
    assert(metadata);
    started.push(steps[0].id);
    return new Promise(resolve => release.push(resolve));
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, candidatePlan(manifest).lanes.length);
  assert(started.length > 1);
  let settled = false;
  pending.then(() => { settled = true; });
  for (const finish of release.slice(0, -1)) finish(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  release.at(-1)(0);
  assert.equal(await pending, 0);
});

test('metadata failures prevent lanes; lane failures and exceptions cancel and await siblings', async (t) => {
  const cwd = fixture(t);
  let calls = 0;
  assert.equal(await verifyCandidate(cwd, { report() {}, run: async () => { calls++; return 42; } }), 42);
  assert.equal(calls, 1);
  for (const throws of [false, true]) {
    let stopped = 0;
    assert.equal(await verifyCandidate(cwd, { report() {}, run: async (steps, { signal }) => {
      if (steps[0].id === 'plugins-check') return 0;
      if (steps[0].id === 'typecheck') {
        await new Promise(resolve => setImmediate(resolve));
        if (throws) throw new Error('runner failure');
        return 124;
      }
      return new Promise(resolve => signal.addEventListener('abort', () => {
        setImmediate(() => { stopped++; resolve(130); });
      }, { once: true }));
    } }), throws ? 1 : 124);
    assert.equal(stopped, candidatePlan(manifest).lanes.length - 1);
  }
});

test('external interruption cancels active lanes and preserves the signal exit code', async (t) => {
  for (const reason of ['SIGINT', 'SIGTERM']) {
    const controller = new AbortController();
    let started = 0, stopped = 0;
    const pending = verifyCandidate(fixture(t), { report() {}, signal: controller.signal,
      run: async (steps, { signal }) => {
        if (steps[0].id === 'plugins-check') return 0;
        started++;
        return new Promise(resolve => signal.addEventListener('abort', () => {
          stopped++; resolve(130);
        }, { once: true }));
      } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, candidatePlan(manifest).lanes.length);
    controller.abort(reason);
    assert.equal(await pending, reason === 'SIGTERM' ? 143 : 130);
    assert.equal(stopped, started);
  }
});
