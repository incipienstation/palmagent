import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, summarize } from '../benchmark-performance.mjs';

test('benchmark keeps tail latency and throughput; comparisons reject different workloads', () => {
  const before = summarize(Array.from({ length: 100 }, (_, i) => i + 1), 1000);
  assert.deepEqual(before, { samples: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, requestsPerSecond: 100 });
  const report = { schemaVersion: 1, context: { fixture: 'tasks-v1', concurrency: 1 }, rounds: [before] };
  const faster = { ...report, rounds: [summarize(Array.from({ length: 100 }, (_, i) => (i + 1) / 2), 500)] };
  assert.equal(compare(report, faster).p95Ms.changePercent, -50);
  assert.equal(compare(report, faster).requestsPerSecond.changePercent, 100);
  assert.throws(() => compare(report, { ...faster, context: { fixture: 'empty-v1', concurrency: 1 } }), /context differs/);
});
