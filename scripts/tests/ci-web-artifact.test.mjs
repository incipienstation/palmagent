import assert from 'node:assert/strict';
import test from 'node:test';
import { findArtifact, retryTransfer, waitForArtifact } from '../ci-web-artifact.mjs';

const artifact = { name: 'ci-pwa', id: 123, expired: false, workflow_run: { id: 42 } };
const listing = (...artifacts) => ({ total_count: artifacts.length, artifacts });

test('parallel preparation waits for the run artifact, including reuse on a failed-job rerun', async () => {
  let time = 0;
  const result = await waitForArtifact({ runId: '42', now: () => time, sleep: async ms => { time += ms; },
    query: async () => time ? listing(artifact) : listing({ name: 'unrelated' }) });
  assert.deepEqual(result, { artifact, seconds: '2.0' });
  // A producer rerun reuses the same immutable ID instead of replacing a live upload.
  assert.equal(findArtifact(listing(artifact), '42'), artifact);
  assert.equal((await waitForArtifact({ runId: '42', query: async () => listing(artifact) })).artifact.id, 123);
  time = 0;
  assert.equal(findArtifact(listing({ ...artifact, expired: true }), '42'), undefined);
  const refreshed = await waitForArtifact({ runId: '42', now: () => time, sleep: async ms => { time += ms; },
    query: async () => listing(time ? { ...artifact, id: 456 } : { ...artifact, expired: true }) });
  assert.equal(refreshed.artifact.id, 456);
});

test('missing, ambiguous, malformed, cross-run and unavailable artifacts fail closed without rebuilding', async () => {
  let time = 0;
  await assert.rejects(waitForArtifact({ runId: '42', timeout: 10, now: () => time,
    sleep: async ms => { time += ms; }, query: async () => listing() }), /bounded wait/);
  for (const response of [listing(artifact, artifact), listing({ ...artifact, expired: 'false' }),
    listing({ ...artifact, workflow_run: { id: 41 } }), listing({ ...artifact, id: '123' }),
    { total_count: 101, artifacts: [artifact] }]) {
    await assert.rejects(waitForArtifact({ runId: '42', query: async () => response }));
  }
  await assert.rejects(waitForArtifact({ runId: '42', query: async () => { throw new Error('API unavailable'); } }), /API unavailable/);
});


test('waits for a complete listing and retries a newly registered archive without changing its ID', async () => {
  let reads = 0;
  const sleep = async () => {};
  const result = await waitForArtifact({ runId: '42', sleep, query: () => ++reads === 1
    ? { total_count: 1, artifacts: [] } : listing(artifact) });
  const failure = status => Object.assign(new Error('archive unavailable'), { stderr: `gh: error (HTTP ${status})` });
  let downloads = 0;
  assert.equal(await retryTransfer(() => {
    if (++downloads === 1) throw failure(404);
    return result.artifact.id;
  }, { archive: true, sleep }), 123);
  await assert.rejects(retryTransfer(() => { throw failure(403); }, {
    archive: true, sleep: () => assert.fail('permission errors must surface immediately'),
  }), /archive unavailable/);
  await assert.rejects(retryTransfer(() => { throw failure(404); }, { archive: true, sleep }), /archive unavailable/);
});
