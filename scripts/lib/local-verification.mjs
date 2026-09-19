import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedPaths, classifyChanges } from './ci-scope.mjs';

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
  const add = (id, command, args, env) => steps.push({ id, command, args, ...(env ? { env } : {}) });
  const node = (id, ...args) => add(id, process.execPath, args);
  const pnpm = (id, ...args) => add(id, 'pnpm', args);
  node('scope-tests', '--test', 'scripts/tests/ci-scope.test.mjs', 'scripts/tests/repository-skills.test.mjs');
  node('skills', 'scripts/sync-skills.mjs', '--check');
  node('source-leaks', 'scripts/validate.mjs');
  node('release', 'scripts/check-release.mjs');
  add('working-diff', 'git', ['diff', '--check']);
  add('staged-diff', 'git', ['diff', '--cached', '--check']);
  if (base && head) add('committed-diff', 'git', ['diff', '--check', `${base}...${head}`, '--']);
  if (scope.code) {
    pnpm('types', 'typecheck');
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
    const env = { REQUIRE_LEAK_DENYLIST: 'true', PKG_PUBLISHABLE: '1', EXPECT_PUBLISHABLE: '1' };
    add('package-assemble', 'pnpm', ['pkg:assemble'], env);
    add('package-release', process.execPath, ['scripts/check-release.mjs', '--artifact'], env);
    add('package-smoke', process.execPath, ['scripts/pkg-smoke.mjs'], env);
  }
  return steps;
}

// Sequential execution avoids concurrent installs/builds and reuses this run's PWA output.
// Child output stays in private temporary files, including on failure; never dump raw logs.
export function runVerification(steps, { cwd, env = process.env, report = console.log } = {}) {
  const logs = mkdtempSync(join(tmpdir(), 'palmagent-verify-'));
  report(`Logs: ${logs}`);
  for (const step of steps) {
    if (step.env?.REQUIRE_LEAK_DENYLIST === 'true'
      && !(env.LEAK_DENYLIST ?? '').split(/[\n,]/).some(value => value.trim())) {
      report(`BLOCKED ${step.id}: LEAK_DENYLIST is required; verification is incomplete.`);
      return 1;
    }
    const log = join(logs, `${step.id}.log`);
    const fd = openSync(log, 'wx', 0o600);
    const start = Date.now();
    report(`RUN ${step.id}`);
    let result;
    try {
      result = spawnSync(step.command, step.args, {
        cwd, env: { ...env, ...step.env }, stdio: ['ignore', fd, fd],
      });
    } finally { closeSync(fd); }
    if (result.error || result.signal || result.status !== 0) {
      report(`FAIL ${step.id}: ${log}`);
      return result.status > 0 ? result.status : 1;
    }
    report(`PASS ${step.id} (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  }
  report(`PASS: ${steps.length} checks completed.`);
  return 0;
}
