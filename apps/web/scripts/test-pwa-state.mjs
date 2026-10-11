import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

// Exercise the actual coordinator with browser lifecycle events and a controlled
// clock. Real worker activation and draft persistence are covered by test-sw-update.
const source = (await readFile(new URL('../src/pwa.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');
const { code } = await transform(source, { loader: 'ts', format: 'cjs', define: {
  __PALMAGENT_WEB_VERSION__: '"1.0.0"', 'import.meta.env.PROD': 'true',
} });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function setup(t, { workerVersion = '1.0.0', controlled = true, waiting = false, update = async () => {}, checkpoint = async () => true, browserWorkPending = () => false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reloads = 0;
  let streamChanges = 0;
  const document = new EventTarget(); document.visibilityState = 'visible';
  const window = new EventTarget(); window.location = { reload() { reloads++; } };
  const worker = new EventTarget();
  worker.postMessage = (message, ports) => {
    if (message.type === 'PALMAGENT_VERSION') ports[0].peer.onmessage?.({ data: { version: workerVersion } });
  };
  const registration = new EventTarget();
  registration.update = update; registration.waiting = waiting ? { postMessage() {} } : null;
  const serviceWorker = new EventTarget(); serviceWorker.controller = controlled ? worker : null;
  serviceWorker.getRegistration = serviceWorker.register = async () => registration;
  class MessageChannel {
    constructor() {
      this.port1 = { close() {} }; this.port2 = { close() {}, peer: this.port1 };
    }
  }
  const module = { exports: {} };
  let stateChanged = () => {};
  const snapshots = [];
  runInNewContext(code, { module, exports: module.exports, document, window,
    navigator: { onLine: true, serviceWorker }, MessageChannel, setTimeout, clearTimeout,
    pauseStreams() { streamChanges++; }, useSyncExternalStore: (subscribe, get) => {
      subscribe(() => snapshots.push(get()));
      return get();
    },
    browserStateChanged() { stateChanged(); }, browserWorkPending,
    checkpointBrowserState: checkpoint, onBrowserStateChange(listener) { stateChanged = listener; },
  });
  const api = module.exports;
  api.startPwaUpdates();
  return { api, registration, window, serviceWorker, snapshots, streamChanges: () => streamChanges, reloads: () => reloads };
}

test('an unresolved message delays screen replacement until its receipt arrives', async (t) => {
  let pending = true;
  const { api, serviceWorker, window, reloads } = setup(t, { browserWorkPending: () => pending });
  await flush();
  api.observeServerVersion('2.0.0');
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  t.mock.timers.tick(1000); await flush();
  assert.equal(reloads(), 0);
  pending = false;
  window.dispatchEvent(new Event('input'));
  t.mock.timers.tick(1000); await flush();
  assert.equal(reloads(), 1);
});

for (const controlled of [true, false]) test(`a downloading worker ${controlled ? 'shows an update before a version header arrives' : 'does not show an update on first installation'}`, async (t) => {
  const { api, registration } = setup(t, { controlled });
  await flush();
  registration.installing = new EventTarget();
  registration.installing.state = 'installing';
  registration.dispatchEvent(new Event('updatefound'));
  assert.equal(api.usePwaUpdate(), controlled);
});

test('progress subscribers follow worker and checkpoint events, not elapsed time', async (t) => {
  let finishCheckpoint;
  const { api, registration, serviceWorker, snapshots, reloads } = setup(t, {
    checkpoint: () => new Promise(resolve => { finishCheckpoint = resolve; }),
  });
  assert.equal(api.usePwaUpdateStage(), 'checking');
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  t.mock.timers.tick(5_000); await flush();
  assert.equal(snapshots.at(-1), 'checking');

  const worker = new EventTarget();
  worker.state = 'installing'; worker.postMessage = () => {};
  registration.installing = worker;
  registration.dispatchEvent(new Event('updatefound'));
  assert.equal(snapshots.at(-1), 'downloading');
  t.mock.timers.tick(5_000); await flush();
  assert.equal(snapshots.at(-1), 'downloading');

  registration.installing = null; registration.waiting = worker;
  worker.state = 'installed'; worker.dispatchEvent(new Event('statechange'));
  assert.equal(snapshots.at(-1), 'ready');
  t.mock.timers.tick(0); await flush();
  t.mock.timers.tick(750); await flush();
  assert.equal(snapshots.at(-1), 'saving');
  finishCheckpoint(true); await flush();
  assert.equal(snapshots.at(-1), 'applying');
  assert.equal(reloads(), 0);

  registration.waiting = null;
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  t.mock.timers.tick(750); await flush();
  assert.equal(snapshots.at(-1), 'applying', 'activation must not jump back to saving');
  finishCheckpoint(true); await flush();
  assert.equal(reloads(), 1);
});

test('progress stays ready while composition defers applying the downloaded update', async (t) => {
  const { api, window, snapshots } = setup(t, { waiting: true });
  api.usePwaUpdateStage();
  await flush(); window.dispatchEvent(new Event('compositionstart'));
  t.mock.timers.tick(31_000); await flush();
  assert.equal(snapshots.at(-1), 'ready');
  window.dispatchEvent(new Event('compositionend'));
  t.mock.timers.tick(750); await flush();
  assert.equal(snapshots.at(-1), 'applying');
});

test('a failed checkpoint pauses progress and retry resumes from the downloaded update', async (t) => {
  let blocked = true;
  const { api, snapshots } = setup(t, { waiting: true, checkpoint: async () => {
    if (blocked) throw new Error('Storage unavailable');
    return true;
  } });
  api.usePwaUpdateStage(); await flush();
  t.mock.timers.tick(750); await flush();
  assert.equal(snapshots.at(-1), 'paused');
  blocked = false; api.retryUpdate(); await flush();
  assert.equal(snapshots.at(-1), 'ready');
  t.mock.timers.tick(750); await flush();
  assert.equal(snapshots.at(-1), 'applying');
});

test('a version returning to the running screen clears its stale banner without reloading', async (t) => {
  const { api, reloads } = setup(t);
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  assert.equal(api.usePwaUpdate(), true);
  api.observeServerVersion('1.0.0');
  assert.equal(api.usePwaUpdate(), false);
  t.mock.timers.tick(31_000); await flush();
  assert.equal(api.usePwaFailure(), false); assert.equal(reloads(), 0);
});

test('an already controlling target recovers a missed activation event after checkpointing', async (t) => {
  let saved = false;
  const { api, reloads } = setup(t, { workerVersion: '2.0.0', checkpoint: async () => { saved = true; return true; } });
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  assert.equal(reloads(), 0);
  t.mock.timers.tick(750); await flush();
  assert.equal(saved, true); assert.equal(reloads(), 1);
});

test('a stale controlling worker is not reloaded and discovery cannot display progress forever', async (t) => {
  const { api, reloads } = setup(t);
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(reloads(), 0); assert.equal(api.usePwaFailure(), true);
  assert.equal(api.usePwaApplying(), false);
});

test('a stalled worker update times out and remains recoverable on a new connectivity event', async (t) => {
  const { api, reloads, registration, window } = setup(t, { update: () => new Promise(() => {}) });
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  t.mock.timers.tick(30_000); await flush();
  assert.equal(api.usePwaFailure(), true); assert.equal(reloads(), 0);
  let checked = false;
  registration.update = async () => { checked = true; };
  window.dispatchEvent(new Event('online')); await flush();
  assert.equal(checked, true);
});


test('routine matching SSE versions do not reconnect streams or broadcast a resume loop', async (t) => {
  const { api, streamChanges } = setup(t);
  await flush();
  for (let i = 0; i < 5; i++) api.observeServerVersion('1.0.0');
  assert.equal(streamChanges(), 0);
});

test('a checkpoint timeout releases transition ownership for a later retry', async (t) => {
  let blocked = true;
  const { api, reloads } = setup(t, { workerVersion: '2.0.0', checkpoint: () => blocked ? new Promise(() => {}) : Promise.resolve(true) });
  await flush(); api.observeServerVersion('2.0.0'); await flush();
  t.mock.timers.tick(750); await flush();
  t.mock.timers.tick(10_000); await flush();
  assert.equal(api.usePwaFailure(), true); assert.equal(reloads(), 0);
  blocked = false; api.retryUpdate(); await flush();
  t.mock.timers.tick(750); await flush();
  assert.equal(reloads(), 1);
});


test('text composition can finish after the deadline without being treated as an update failure', async (t) => {
  const { api, window, reloads } = setup(t, { workerVersion: '2.0.0' });
  await flush(); window.dispatchEvent(new Event('compositionstart'));
  api.observeServerVersion('2.0.0'); await flush();
  t.mock.timers.tick(31_000); await flush();
  assert.equal(api.usePwaFailure(), false); assert.equal(reloads(), 0);
  window.dispatchEvent(new Event('compositionend')); await flush();
  t.mock.timers.tick(750); await flush();
  assert.equal(reloads(), 1);
});


test('a connectivity event repairs a missing registration', async (t) => {
  const { serviceWorker, registration, window } = setup(t);
  await flush();
  let registrations = 0;
  serviceWorker.getRegistration = async () => undefined;
  serviceWorker.register = async () => { registrations++; return registration; };
  window.dispatchEvent(new Event('online')); await flush();
  assert.equal(registrations, 1);
});

test('an unavailable registration reports failure immediately instead of waiting for a nonexistent worker', async (t) => {
  const { api, serviceWorker, reloads } = setup(t);
  await flush();
  serviceWorker.getRegistration = serviceWorker.register = async () => undefined;
  api.observeServerVersion('2.0.0'); await flush();
  assert.equal(api.usePwaFailure(), true); assert.equal(reloads(), 0);
});
