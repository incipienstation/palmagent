import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));

// Own the listener (port 0), build bytes and server lifetime for this run.
// Never discover/reuse another checkout's server through a well-known port.
export async function createWebHarness({ count = 2, dist = join(webDir, 'dist'), env = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'palmagent-web-'));
  const snapshot = join(directory, 'dist');
  const runId = randomUUID();
  const children = [];
  let closing;
  const close = () => closing ??= (async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    })));
    await rm(directory, { recursive: true, force: true });
  })();
  try {
    await cp(dist, snapshot, { recursive: true });
    const urls = [];
    for (let i = 0; i < count; i++) {
      const child = spawn(process.execPath, [join(webDir, 'tests/mock-server.mjs')], {
        env: { ...process.env, ...env, PORT: '0', E2E_DIST: snapshot, E2E_RUN_ID: runId },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.push(child);
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Mock server startup timed out')), 10_000);
        const finish = (error, url) => {
          clearTimeout(timer);
          child.off('error', onError); child.off('exit', onExit); child.off('message', onMessage);
          if (error) reject(error); else resolve(url);
        };
        const onError = error => finish(error);
        const onExit = () => finish(new Error('Mock server exited before becoming ready'));
        const onMessage = message => {
          if (message.runId !== runId || !/^http:\/\/localhost:\d+$/.test(message.url)) {
            finish(new Error('Mock server identity mismatch'));
          } else finish(undefined, message.url);
        };
        child.once('error', onError); child.once('exit', onExit); child.once('message', onMessage);
      });
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
      assert(response.ok);
      assert.equal((await response.json()).runId, runId, 'health must identify this run');
      urls.push(url);
    }
    return { urls, dist: snapshot, runId, close };
  } catch (error) {
    await close();
    throw error;
  }
}
