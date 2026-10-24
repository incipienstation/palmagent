import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';

export function summarize(samples, elapsedMs) {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
    requestsPerSecond: sorted.length / (elapsedMs / 1000) };
}
export function compare(baseline, candidate) {
  if (baseline.schemaVersion !== 1 || candidate.schemaVersion !== 1) throw new Error('Unsupported benchmark report.');
  if (JSON.stringify(baseline.context) !== JSON.stringify(candidate.context)) {
    throw new Error('Workload or machine context differs. Run both versions on the same machine and fixture with identical benchmark options.');
  }
  const median = (report, name) => [...report.rounds.map(round => round[name])].sort((a, b) => a - b)[Math.floor(report.rounds.length / 2)];
  return Object.fromEntries(['p50Ms', 'p95Ms', 'p99Ms', 'requestsPerSecond'].map(name => {
    const before = median(baseline, name), after = median(candidate, name);
    return [name, { baseline: before, candidate: after, changePercent: before > 0 ? (after / before - 1) * 100 : null }];
  }));
}
async function main() {
  const { values } = parseArgs({ options: {
    url: { type: 'string' }, scenario: { type: 'string', default: 'tasks' }, requests: { type: 'string', default: '1000' },
    concurrency: { type: 'string', default: '1' }, rounds: { type: 'string', default: '5' },
    fixture: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' }, candidate: { type: 'string' },
  } });
  if (values.baseline || values.candidate) {
    if (!values.baseline || !values.candidate) throw new Error('Use --baseline and --candidate together.');
    console.log(JSON.stringify(compare(JSON.parse(readFileSync(values.baseline)), JSON.parse(readFileSync(values.candidate))), null, 2));
    return;
  }
  if (!values.url || !values.out || !values.fixture) throw new Error('Use --url <isolated loopback server> --fixture <dataset revision> --out <report.json>.');
  const base = new URL(values.url);
  if (base.hostname !== 'localhost' || base.username || base.password || base.search ||
      !['http:', 'https:'].includes(base.protocol)) throw new Error('Benchmark only an isolated loopback validation server.');
  if (!['tasks', 'routines', 'health'].includes(values.scenario) || !/^[a-zA-Z0-9._-]{1,64}$/.test(values.fixture)) throw new Error('Invalid scenario or fixture revision.');
  const number = (name, max) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const requests = number('requests', 10000), concurrency = number('concurrency', 32), rounds = number('rounds', 20);
  const headers = process.env.PALMAGENT_BENCH_COOKIE ? { cookie: process.env.PALMAGENT_BENCH_COOKIE } : {};
  async function get(path) {
    const response = await fetch(new URL(path, base), { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Benchmark request failed (${response.status}); no comparison was produced.`); }
    const text = await response.text();
    return { json: JSON.parse(text), bytes: Buffer.byteLength(text) };
  }
  const health = (await get('/api/health')).json;
  if (!health.build?.version || !health.build?.sourceCommit || health.build.dirty) throw new Error('Use a clean, identified build for a reproducible comparison.');
  const path = values.scenario === 'health' ? '/api/health' : `/api/${values.scenario}`;
  const initial = await get(path);
  const taskCount = values.scenario === 'tasks' ? initial.json.tasks?.length : null;
  if (values.scenario === 'tasks' && !Number.isSafeInteger(taskCount)) throw new Error('Unexpected task-list response.');
  const routineCount = values.scenario === 'routines' ? initial.json.routines?.length : null;
  if (values.scenario === 'routines' && !Number.isSafeInteger(routineCount)) throw new Error('Unexpected routine-list response.');
  for (let i = 0; i < 20; i++) await get(path);
  const results = [];
  for (let round = 0; round < rounds; round++) {
    const samples = [];
    let issued = 0, bytes = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (issued++ < requests) {
        const start = performance.now();
        const response = await get(path);
        if (taskCount !== null && response.json.tasks?.length !== taskCount) throw new Error('Fixture changed during measurement.');
        if (routineCount !== null && response.json.routines?.length !== routineCount) throw new Error('Fixture changed during measurement.');
        samples.push(performance.now() - start); bytes += response.bytes;
      }
    }));
    results.push({ ...summarize(samples, performance.now() - started), meanResponseBytes: bytes / requests });
  }
  const final = (await get('/api/health')).json;
  if (final.build?.sourceCommit !== health.build.sourceCommit || final.build?.version !== health.build.version) throw new Error('Server changed version during measurement.');
  const report = { schemaVersion: 1, build: health.build,
    context: { workload: 'palmagent-http-v1', scenario: values.scenario, fixture: values.fixture, taskCount, ...(routineCount === null ? {} : { routineCount }), requests, concurrency, rounds,
      os: process.platform, arch: process.arch, cpuModel: cpus()[0]?.model, cpuCount: cpus().length, memoryBytes: totalmem(), clientNode: process.version },
    rounds: results };
  writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Benchmark report saved. It contains aggregate measurements only and was not uploaded.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
