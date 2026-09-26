import { execFileSync, spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths, classifyChanges } from './ci-scope.mjs';

export function requireVerificationNode(cwd, version = process.versions.node) {
  const expected = readFileSync(join(cwd, '.nvmrc'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(expected)) throw new Error('.nvmrc must pin an exact Node version.');
  if (version !== expected) {
    throw new Error(`Verification requires Node ${expected}; running ${version}. Activate .nvmrc (nvm install && nvm use) before retrying.`);
  }
}

// Refresh named bases; immutable commit arguments deliberately select that exact base.
// Unavailable refs, fetch failures, or incomplete history can never select fewer checks.
export function localScope(cwd, baseRef = 'origin/develop') {
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    if (!/^[a-f0-9]{40}$/.test(baseRef)) {
      const slash = baseRef.indexOf('/');
      if (slash < 1 || baseRef.startsWith('-')) throw new Error('Expected remote/branch or commit');
      const remote = baseRef.slice(0, slash), branch = baseRef.slice(slash + 1);
      git('check-ref-format', `refs/remotes/${baseRef}`);
      git('fetch', '--no-tags', remote, `refs/heads/${branch}:refs/remotes/${baseRef}`);
    }
    const base = git('rev-parse', '--verify', `${baseRef}^{commit}`).trim();
    const head = git('rev-parse', '--verify', 'HEAD').trim();
    const paths = [...new Set([
      ...changedPaths(cwd, base, head),
      ...git('diff', '--cached', '--name-only', '--no-renames', '-z', '--').split('\0'),
      ...git('diff', '--name-only', '--no-renames', '-z', '--').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ].filter(Boolean))];
    return { scope: classifyChanges(paths), base, head, paths };
  } catch {
    return { scope: classifyChanges(undefined), reason: 'Base refresh or change history unavailable; selecting every check.' };
  }
}

export function verificationSteps({ scope, base, head }) {
  const steps = [];
  const add = (id, command, args, env) => steps.push({ id, command, args,
    timeoutMs: id === 'web-tests' ? 15 * 60_000 : 10 * 60_000, ...(env ? { env } : {}) });
  const node = (id, ...args) => add(id, process.execPath, args);
  const pnpm = (id, ...args) => add(id, 'pnpm', args);
  node('scope-tests', '--test', 'scripts/tests/ci-scope.test.mjs', 'scripts/tests/repository-skills.test.mjs');
  node('skills', 'scripts/sync-skills.mjs', '--check');
  node('source-leaks', 'scripts/validate.mjs');
  node('release', 'scripts/check-release.mjs');
  add('working-diff', 'git', ['diff', '--check']);
  add('staged-diff', 'git', ['diff', '--cached', '--check']);
  if (base && head) add('committed-diff', 'git', ['diff', '--check', `${base}...${head}`, '--']);
  if (scope.types) pnpm('types', 'typecheck');
  if (scope.tooling) {
    pnpm('tooling', 'pkg:check');
    // pkg:check already includes the scope and repository-skill test files.
    steps.splice(steps.findIndex(({ id }) => id === 'scope-tests'), 1);
  }
  if (scope.server) {
    pnpm('server-contracts', 'server:contracts');
    pnpm('server-smoke', 'server:smoke');
  }
  if (scope.web || scope.package) pnpm('web-build', 'web:build');
  if (scope.web) pnpm('web-tests', 'web:verify:built');
  if (scope.package) {
    const env = { PKG_PUBLISHABLE: '1', EXPECT_PUBLISHABLE: '1' };
    add('package-assemble', 'pnpm', ['pkg:assemble'], env);
    add('package-release', process.execPath, ['scripts/check-release.mjs', '--artifact'], env);
    add('package-smoke', process.execPath, ['scripts/pkg-smoke.mjs'], env);
  }
  return steps;
}

// A separate POSIX process group lets cancellation reach pnpm's descendants, even if the
// direct child exits before a descendant that ignores SIGTERM. Windows uses taskkill /T.
function runStep(step, { cwd, env, fd, timeoutMs, killGraceMs, signal }) {
  return new Promise(resolve => {
    let child, timer, killTimer, exited = false, cleaned = false, finished = false;
    let outcome = {}, stopped;
    const finish = () => {
      if (finished || !exited || (stopped && !cleaned)) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ ...outcome, stopped });
    };
    const kill = (force) => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} });
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (error) { if (error.code !== 'ESRCH') outcome.error = true; }
      }
    };
    const stop = (reason) => {
      if (stopped || finished) return;
      stopped = reason;
      clearTimeout(timer);
      kill(false);
      // Keep this timer even after the direct child exits: its children may still be alive.
      killTimer = setTimeout(() => { kill(true); cleaned = true; finish(); }, killGraceMs);
    };
    const abort = () => stop(signal?.reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT');
    try {
      child = spawn(step.command, step.args, {
        cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', fd, fd],
      });
    } catch {
      exited = true; outcome.error = true; finish(); return;
    }
    child.on('error', () => { exited = true; outcome.error = true; finish(); });
    child.on('close', (status, childSignal) => {
      exited = true; outcome = { ...outcome, status, signal: childSignal }; finish();
    });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Sequential execution avoids concurrent installs/builds and reuses this run's PWA output.
// Child output stays in private temporary files, including on failure; never dump raw logs.
export async function runVerification(steps, {
  cwd, env = process.env, report = console.log, signal, timeoutMs, killGraceMs = 2000,
} = {}) {
  const validDelay = value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
  if (!validDelay(killGraceMs) || (timeoutMs !== undefined && !validDelay(timeoutMs))
    || steps.some(step => !validDelay(timeoutMs ?? step.timeoutMs ?? 10 * 60_000))) {
    throw new Error('Verification time limits must be positive timer-safe integers');
  }
  const logs = mkdtempSync(join(tmpdir(), 'palmagent-verify-'));
  report(`Logs: ${logs}`);
  for (const step of steps) {
    if (signal?.aborted) {
      report('CANCELLED: verification stopped before the next check.');
      return signal.reason === 'SIGTERM' ? 143 : 130;
    }
    const log = join(logs, `${step.id}.log`);
    const fd = openSync(log, 'wx', 0o600);
    const start = Date.now();
    report(`RUN ${step.id}`);
    let result;
    try {
      result = await runStep(step, {
        cwd, env: { ...env, NX_DAEMON: 'false', ...step.env }, fd, signal,
        timeoutMs: timeoutMs ?? step.timeoutMs ?? 10 * 60_000, killGraceMs,
      });
    } finally { closeSync(fd); }
    if (result.stopped) {
      report(`${result.stopped === 'timeout' ? 'TIMEOUT' : 'CANCELLED'} ${step.id}: ${log}`);
      return result.stopped === 'timeout' ? 124 : result.stopped === 'SIGTERM' ? 143 : 130;
    }
    if (result.error || result.signal || result.status !== 0) {
      report(`FAIL ${step.id}: ${log}`);
      return result.status > 0 ? result.status : 1;
    }
    report(`PASS ${step.id} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  report(`PASS: ${steps.length} checks completed.`);
  return 0;
}
