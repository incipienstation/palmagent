import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWebHarness } from './web-harness.mjs';

test('concurrent runs own separate listeners and build bytes and release their resources', async t => {
  const source = await mkdtemp(join(tmpdir(), 'palmagent-web-fixture-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, 'index.html'), 'fixture build');
  await writeFile(join(source, 'sw.js'), 'original worker');
  const runs = [];
  t.after(() => Promise.all(runs.map(run => run.close())));
  await Promise.all([1, 2].map(async () => {
    runs.push(await createWebHarness({ dist: source }));
  }));
  assert.equal(new Set(runs.flatMap(run => run.urls)).size, 4);
  await writeFile(join(runs[0].dist, 'sw.js'), 'updated worker');
  assert.equal(await readFile(join(source, 'sw.js'), 'utf8'), 'original worker');
  assert.equal(await readFile(join(runs[1].dist, 'sw.js'), 'utf8'), 'original worker');
  for (const run of runs) {
    for (const url of run.urls) {
      const health = await (await fetch(`${url}/api/health`)).json();
      assert.equal(health.runId, run.runId);
      assert.equal(await (await fetch(url)).text(), 'fixture build');
    }
    await run.close();
    await assert.rejects(readFile(join(run.dist, 'sw.js')), { code: 'ENOENT' });
    await assert.rejects(fetch(`${run.urls[0]}/api/health`, { signal: AbortSignal.timeout(1000) }));
  }
});
