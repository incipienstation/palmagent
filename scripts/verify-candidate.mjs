import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runVerification } from './lib/local-verification.mjs';

const fullGate = ['typecheck', 'server:contracts', 'server:smoke', 'pkg:check',
  'web:verify', 'plugins:check', 'release:check'];
const step = command => ({ id: command.replaceAll(':', '-'), command: 'pnpm', args: [command],
  timeoutMs: 15 * 60_000 });

export function candidatePlan(manifest) {
  // Workflow tools can verify an older source checkout. Never omit an unfamiliar
  // source gate, or reorder lifecycle hooks with potentially shared side effects.
  const commands = manifest.scripts?.verify?.split('&&').map(value => value.trim());
  const known = JSON.stringify(commands) === JSON.stringify(fullGate.map(name => `pnpm ${name}`));
  const hooks = ['verify', ...fullGate].some(name =>
    manifest.scripts?.[`pre${name}`] || manifest.scripts?.[`post${name}`]);
  if (!known || hooks) return { before: [step('verify')], lanes: [] };
  return {
    before: ['plugins:check', 'release:check'].map(step),
    lanes: [['typecheck', 'pkg:check'], ['server:contracts', 'server:smoke'], ['web:verify']].map(lane => lane.map(step)),
  };
}

// Only split the known browser gate. Source-owned additions and lifecycle hooks
// must retain their original execution through the complete source gate.
export function canDistributeCandidate(manifest, webManifest) {
  const scripts = manifest.scripts ?? {};
  const web = webManifest.scripts ?? {};
  return candidatePlan(manifest).lanes.length > 0
    && scripts['web:build'] === 'pnpm --filter @palmagent/web build'
    && scripts['web:verify'] === 'pnpm web:build && pnpm web:verify:built'
    && scripts['web:verify:built'] === 'node apps/web/scripts/run-e2e.mjs && node apps/web/scripts/test-sw-update.mjs'
    && web.build === 'vite build'
    && !['web:build', 'web:verify:built'].some(name => scripts[`pre${name}`] || scripts[`post${name}`])
    && !web.prebuild && !web.postbuild;
}

export function candidateLane(name) {
  const node = (id, ...args) => ({ id, command: process.execPath, args, timeoutMs: 15 * 60_000 });
  const lanes = {
    tooling: ['typecheck', 'pkg:check'].map(step),
    server: ['server:contracts', 'server:smoke'].map(step),
    'web-1': [node('web-shard-1', 'apps/web/scripts/run-e2e.mjs', '--shard=1/3')],
    'web-2': [node('web-shard-2', 'apps/web/scripts/run-e2e.mjs', '--shard=2/3')],
    'web-3': [node('web-shard-3', 'apps/web/scripts/run-e2e.mjs', '--shard=3/3')],
    sw: [node('service-worker', 'apps/web/scripts/test-sw-update.mjs')],
  };
  if (!Object.hasOwn(lanes, name)) throw new Error('Unknown candidate verification lane.');
  return lanes[name];
}

export function requireCandidateChecks(results) {
  const { prepare, verify } = results ?? {};
  if (prepare?.result !== 'success'
    || !['true', 'false'].includes(prepare.outputs?.reuse)
    || !['true', 'false'].includes(prepare.outputs?.distributed)) {
    throw new Error('Candidate preparation evidence is incomplete.');
  }
  const required = prepare.outputs.reuse === 'false' && prepare.outputs.distributed === 'true';
  if (required ? verify?.result !== 'success' : verify?.result !== 'skipped') {
    throw new Error('Candidate verification lanes did not satisfy the selected plan.');
  }
}

function distributedSource(cwd) {
  try {
    return canDistributeCandidate(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')),
      JSON.parse(readFileSync(join(cwd, 'apps/web/package.json'), 'utf8')));
  } catch { return false; }
}

function reportCheck(message) {
  console.log(message);
  const failed = /^(?:FAIL|TIMEOUT) [^:]+: (.+)$/.exec(message);
  if (process.env.GITHUB_ACTIONS === 'true' && failed) {
    try { console.log(readFileSync(failed[1], 'utf8').slice(-16_384)); } catch {}
  }
}

export async function verifyCandidate(cwd, { env = process.env, signal, run = runVerification,
  report = console.log } = {}) {
  const plan = candidatePlan(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let failure = 0;
  const execute = async (steps, name) => {
    try {
      const code = await run(steps, { cwd, env, signal: controller.signal,
        report: message => {
          report(`[${name}] ${message}`);
          // Runner logs are temporary. Keep the failing check's diagnostic tail
          // in Actions output before the hosted machine is discarded.
          const failed = /^(?:FAIL|TIMEOUT) [^:]+: (.+)$/.exec(message);
          if (env.GITHUB_ACTIONS === 'true' && failed) {
            try { report(readFileSync(failed[1], 'utf8').slice(-16_384)); } catch {}
          }
        } });
      if (code && !failure) { failure = code; controller.abort('lane-failure'); }
    } catch {
      if (!failure) { failure = 1; controller.abort('lane-failure'); }
      report(`[${name}] Verification runner failed.`);
    }
  };
  try {
    await execute(plan.before, 'metadata');
    if (!failure) await Promise.all(plan.lanes.map((lane, i) => execute(lane, `lane-${i + 1}`)));
    return signal?.aborted ? (signal.reason === 'SIGTERM' ? 143 : 130) : failure;
  } finally { signal?.removeEventListener('abort', abort); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort('SIGINT');
  const terminate = () => controller.abort('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const [source = '.', mode = 'full', lane] = process.argv.slice(2);
    const cwd = resolve(source);
    if (mode === 'plan') {
      const distributed = distributedSource(cwd);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `distributed=${distributed}\n`);
      console.log(JSON.stringify({ distributed }));
    } else if (mode === 'results') {
      requireCandidateChecks(JSON.parse(process.env.RESULTS));
    } else if (mode === 'lane') {
      if (!distributedSource(cwd)) throw new Error('Source gate cannot be distributed.');
      process.exitCode = await runVerification(candidateLane(lane), { cwd, signal: controller.signal, report: reportCheck });
    } else if (mode === 'full') {
      process.exitCode = await verifyCandidate(cwd, { signal: controller.signal });
    } else throw new Error('Unknown candidate verification mode.');
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
