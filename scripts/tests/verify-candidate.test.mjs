import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { candidatePlan, verifyCandidate } from '../verify-candidate.mjs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
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
