import { readFileSync } from 'node:fs';
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
  try { process.exitCode = await verifyCandidate(resolve(process.argv[2] ?? '.'), { signal: controller.signal }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
}
