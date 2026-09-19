import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseTiming } from '../lib/release-timing.mjs';

test('records durations and failure outcomes without leaking operation data or changing errors', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-timing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const summaryFile = join(root, 'summary.md'), events = [];
  let clock = 0;
  const measure = releaseTiming({ now: () => clock, report: value => events.push(JSON.parse(value)), summaryFile });
  const value = { privatePayload: 'not-for-logs' };
  assert.equal(await measure('npm-upload', () => { clock += 1200; return value; }), value);
  const error = new Error('private error payload');
  await assert.rejects(measure('registry-visibility', async () => { clock += 165000; throw error; }), e => e === error);
  assert.deepEqual(events, [
    { phase: 'npm-upload', status: 'started' }, { phase: 'npm-upload', status: 'success', durationMs: 1200 },
    { phase: 'registry-visibility', status: 'started' }, { phase: 'registry-visibility', status: 'failed', durationMs: 165000 },
  ]);
  const summary = readFileSync(summaryFile, 'utf8');
  assert.equal(summary.match(/Publication timings/g).length, 1);
  assert(summary.includes('| registry-visibility | failed | 165.000 |'));
  assert(!summary.includes('private') && !JSON.stringify(events).includes('private'));
});

test('broken logging or summary storage cannot turn a successful upload into a retry', async () => {
  const measure = releaseTiming({ report() { throw new Error('logging failed'); }, summaryFile: '/dev/null/summary' });
  assert.equal(await measure('npm-upload', () => 'uploaded'), 'uploaded');
  const error = new Error('upload failed');
  await assert.rejects(measure('npm-upload', () => { throw error; }), e => e === error);
});
