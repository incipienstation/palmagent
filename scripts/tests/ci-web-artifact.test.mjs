import assert from 'node:assert/strict';
import test from 'node:test';
import { findArtifact, waitForArtifact } from '../ci-web-artifact.mjs';

const artifact = { name: 'ci-pwa', id: 123, expired: false, workflow_run: { id: 42 } };
const listing = (...artifacts) => ({ total_count: artifacts.length, artifacts });

test('parallel preparation waits for the run artifact, including reuse on a failed-job rerun', async () => {
  let time = 0;
  const result = await waitForArtifact({ runId: '42', now: () => time, sleep: async ms => { time += ms; },
    query: async () => time ? listing(artifact) : listing({ name: 'unrelated' }) });
  assert.deepEqual(result, { id: 123, seconds: '2.0' });
  // A producer rerun reuses the same immutable ID instead of replacing a live upload.
  assert.equal(findArtifact(listing(artifact), '42'), 123);
  assert.equal((await waitForArtifact({ runId: '42', query: async () => listing(artifact) })).id, 123);
  time = 0;
  assert.equal(findArtifact(listing({ ...artifact, expired: true }), '42'), undefined);
  const refreshed = await waitForArtifact({ runId: '42', now: () => time, sleep: async ms => { time += ms; },
    query: async () => listing(time ? { ...artifact, id: 456 } : { ...artifact, expired: true }) });
  assert.equal(refreshed.id, 456);
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
