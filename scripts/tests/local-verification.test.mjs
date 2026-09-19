import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { localScope, requireVerificationNode, runVerification, verificationSteps } from '../lib/local-verification.mjs';

const full = { types: true, tooling: true, server: true, web: true, package: true };
const none = { types: false, tooling: false, server: false, web: false, package: false };

function fixture(t, cleanup = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-local-verification-'));
  t.after(() => { cleanup(cwd); rmSync(cwd, { recursive: true, force: true }); });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  git('init', '-b', 'develop');
  write('README.md', 'base\n'); write('apps/server/old.ts', 'base\n');
  git('add', '.'); git('commit', '-m', 'base');
  return { cwd, git, write, base: git('rev-parse', 'HEAD') };
}

test('verification requires the exact repository Node version', t => {
  const { cwd, write } = fixture(t);
  write('.nvmrc', '24.21.0\n');
  requireVerificationNode(cwd, '24.21.0');
  assert.throws(() => requireVerificationNode(cwd, '24.14.0'), /requires Node 24.21.0; running 24.14.0/);
  write('.nvmrc', '24\n');
  assert.throws(() => requireVerificationNode(cwd, '24.21.0'), /exact Node version/);
});

test('local scope includes earlier commits, staged reversals, untracked files, and renames', t => {
  const { cwd, git, write, base } = fixture(t);
  write('apps/web/README.md', 'docs\n');
  assert.deepEqual(localScope(cwd, base).scope, none);
  write('apps/server/old.ts', 'staged\n'); git('add', 'apps/server/old.ts');
  write('apps/server/old.ts', 'base\n');
  assert.equal(localScope(cwd, base).scope.server, true);
  write('apps/web/new.ts', 'code\n');
  assert.equal(localScope(cwd, base).scope.web, true);
  git('add', '.'); git('commit', '-m', 'code');
  write('README.md', 'later docs\n'); git('add', '.'); git('commit', '-m', 'docs');
  assert.equal(localScope(cwd, base).scope.web, true);
  mkdirSync(join(cwd, 'docs'));
  git('mv', 'apps/server/old.ts', 'docs/moved.md');
  const result = localScope(cwd, base);
  assert(result.paths.includes('apps/server/old.ts'));
  assert(result.paths.includes('docs/moved.md'));
  assert.equal(result.scope.server, true);
});

test('named bases refresh before selection and failed refresh never trusts stale refs', t => {
  const { cwd, git, write } = fixture(t);
  const remote = mkdtempSync(join(tmpdir(), 'palmagent-base-'));
  t.after(() => rmSync(remote, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'develop');
  write('README.md', 'updated\n'); git('add', '.'); git('commit', '-m', 'base update');
  git('push', 'origin', 'develop');
  const currentBase = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/develop', git('rev-parse', 'HEAD~1'));
  write('apps/web/README.md', 'docs\n');
  const result = localScope(cwd);
  assert.equal(result.base, currentBase);
  assert.deepEqual(result.scope, none);
  git('remote', 'set-url', 'origin', join(remote, 'unavailable'));
  assert.deepEqual(localScope(cwd).scope, full);
  assert.deepEqual(localScope(cwd, '0'.repeat(40)).scope, full);
});

test('check selection deduplicates metadata, scope tests, and shared PWA builds', () => {
  const docs = verificationSteps({ scope: none });
  assert(docs.every(step => step.command !== 'pnpm'));
  assert(docs.some(step => step.id === 'scope-tests'));
  const steps = verificationSteps({ scope: full, base: 'a'.repeat(40), head: 'b'.repeat(40) });
  assert.equal(new Set(steps.map(step => step.id)).size, steps.length);
  assert.equal(steps.filter(step => step.args[0] === 'web:build').length, 1);
  assert(steps.findIndex(step => step.id === 'web-build') < steps.findIndex(step => step.id === 'package-assemble'));
  assert(steps.some(step => step.args[0] === 'web:verify:built'));
  assert(!steps.some(step => step.id === 'scope-tests')); // Included by pkg:check.
  assert(!steps.some(step => step.args[0] === 'verify' || step.args[0] === 'web:verify'));
  assert.equal(steps.filter(step => step.args.includes('scripts/check-release.mjs') && !step.args.includes('--artifact')).length, 1);
  assert(steps.filter(step => step.id.startsWith('package-')).every(step => step.env.REQUIRE_LEAK_DENYLIST === 'true'));
});

test('type and tooling selection remain independent in local verification', () => {
  for (const [types, tooling] of [[true, false], [false, true], [false, false]]) {
    const steps = verificationSteps({ scope: { ...none, types, tooling, web: true } });
    assert.equal(steps.some(step => step.id === 'types'), types);
    assert.equal(steps.some(step => step.id === 'tooling'), tooling);
    assert.equal(steps.some(step => step.id === 'scope-tests'), !tooling);
    assert(steps.some(step => step.id === 'web-tests'));
  }
});

test('runner stops at failure, preserves private logs, and does not echo child output', async t => {
  const { cwd } = fixture(t), messages = [];
  const report = value => {
    messages.push(value);
    if (value.startsWith('Logs: ')) t.after(() => rmSync(value.slice(6), { recursive: true, force: true }));
  };
  const steps = [
    { id: 'first', command: process.execPath, args: ['-e', 'console.log("child-output"); process.exit(7)'] },
    { id: 'later', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("unexpected", "ran")'] },
  ];
  assert.equal(await runVerification(steps, { cwd, report }), 7);
  assert(!existsSync(join(cwd, 'unexpected')));
  assert(!messages.join('\n').includes('child-output'));
  const logs = messages.find(value => value.startsWith('Logs: ')).slice(6);
  assert.match(readFileSync(join(logs, 'first.log'), 'utf8'), /child-output/);
  assert.equal(statSync(join(logs, 'first.log')).mode & 0o777, 0o600);
  assert.equal(statSync(logs).mode & 0o777, 0o700);
});

test('runner completes source steps but cannot run package steps without the denylist', async t => {
  const { cwd } = fixture(t), messages = [];
  const report = value => {
    messages.push(value);
    if (value.startsWith('Logs: ')) t.after(() => rmSync(value.slice(6), { recursive: true, force: true }));
  };
  const step = { id: 'success', command: process.execPath, args: ['-e', 'process.exit(0)'] };
  assert.equal(await runVerification([step], { cwd, report }), 0);
  assert(messages.some(value => value.startsWith('PASS: 1')));
  for (const denylist of ['', ' ,\n']) {
    messages.length = 0;
    assert.equal(await runVerification([step, { ...step, id: 'package', env: { REQUIRE_LEAK_DENYLIST: 'true' } }],
      { cwd, report, env: { LEAK_DENYLIST: denylist } }), 1);
    assert(messages.some(value => value.startsWith('PASS success')));
    assert(messages.some(value => value.startsWith('BLOCKED package')));
    assert(!messages.includes('RUN package'));
  }
  assert.equal(await runVerification([{
    ...step, id: 'package', env: { REQUIRE_LEAK_DENYLIST: 'true' },
    args: ['-e', 'if (!process.env.LEAK_DENYLIST || process.env.REQUIRE_LEAK_DENYLIST !== "true") process.exit(9)'],
  }], { cwd, report, env: { LEAK_DENYLIST: 'fixture-denied-phrase' } }), 0);
  assert.equal(await runVerification([{ ...step, command: join(cwd, 'missing-executable') }], { cwd, report }), 1);
});

test('CLI rejects unknown options without starting verification', () => {
  for (const args of [['--unknown'], ['--timeout-seconds', '0'], ['--timeout-seconds', 'NaN'], ['--timeout-seconds', '86401']]) {
    const result = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, '');
  }
});

const hangingTree = `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  process.on('SIGTERM', () => process.exit(0));
  spawn(process.execPath, ['-e', \`
    process.on('SIGTERM', () => {});
    require('node:fs').writeFileSync('descendant.pid', String(process.pid));
    setInterval(() => {}, 1000);
  \`], { stdio: 'ignore' });
  writeFileSync('leader.pid', String(process.pid));
  setInterval(() => {}, 1000);
`;

async function waitUntil(predicate, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(Date.now() < until, 'process condition did not settle');
    await delay(20);
  }
}

function processRunning(pid) {
  try {
    // An orphan may briefly remain as an exited zombie until the host reaps it.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    process.kill(pid, 0); return true;
  } catch (error) { if (['ESRCH', 'ENOENT'].includes(error.code)) return false; throw error; }
}

function treeFixture(t) {
  return fixture(t, cwd => {
    const pidFile = join(cwd, 'leader.pid');
    if (existsSync(pidFile)) {
      try { process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    }
  });
}

test('timeout kills a resistant descendant after its parent exits and never runs the next step',
  { skip: process.platform === 'win32', timeout: 12000 }, async t => {
    const { cwd } = treeFixture(t), messages = [];
    const report = value => {
      messages.push(value);
      if (value.startsWith('Logs: ')) t.after(() => rmSync(value.slice(6), { recursive: true, force: true }));
    };
    const started = Date.now();
    const result = runVerification([
      { id: 'hung', command: process.execPath, args: ['-e', hangingTree] },
      { id: 'later', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ], { cwd, report, timeoutMs: 2000, killGraceMs: 100 });
    await waitUntil(() => existsSync(join(cwd, 'descendant.pid')));
    const descendant = Number(readFileSync(join(cwd, 'descendant.pid'), 'utf8'));
    assert.equal(await result, 124);
    await waitUntil(() => !processRunning(descendant));
    assert(Date.now() - started < 8000);
    assert(messages.some(value => value.startsWith('TIMEOUT hung')));
    assert(!messages.includes('RUN later'));
  });

for (const [signal, expected] of [['SIGINT', 130], ['SIGTERM', 143], ['timeout', 124]]) {
  test(`CLI ${signal} cleans up the active process group and returns ${expected}`,
    { skip: process.platform === 'win32', timeout: 12000 }, async t => {
      const { cwd, write } = treeFixture(t);
      // Use the actual CLI signal wiring with a hermetic plan, avoiding network and real checks.
      write('scripts/verify-local.mjs', readFileSync(resolve('scripts/verify-local.mjs'), 'utf8'));
      write('.nvmrc', `${process.versions.node}\n`);
      const step = { id: 'hung', command: process.execPath, args: ['-e', hangingTree] };
      write('scripts/lib/local-verification.mjs', `
        export { runVerification, requireVerificationNode } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/local-verification.mjs')).href)};
        export const localScope = () => ({ scope: {} });
        export const verificationSteps = () => [${JSON.stringify(step)}];
      `);
      const child = spawn(process.execPath,
        ['scripts/verify-local.mjs', ...(signal === 'timeout' ? ['--timeout-seconds', '1'] : [])],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.resume();
      const completed = new Promise(resolve => child.on('close', resolve));
      await waitUntil(() => existsSync(join(cwd, 'descendant.pid')));
      const descendant = Number(readFileSync(join(cwd, 'descendant.pid'), 'utf8'));
      if (signal !== 'timeout') child.kill(signal);
      assert.equal(await completed, expected);
      await waitUntil(() => !processRunning(descendant));
      assert.match(output, signal === 'timeout' ? /TIMEOUT hung/ : /CANCELLED hung/);
      const logs = output.split('\n').find(line => line.startsWith('Logs: '))?.slice(6);
      if (logs) rmSync(logs, { recursive: true, force: true });
    });
}

test('an already cancelled run starts no checks', async t => {
  const { cwd } = fixture(t), messages = [], controller = new AbortController();
  controller.abort('SIGTERM');
  assert.equal(await runVerification([{ id: 'never', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    { cwd, signal: controller.signal, report: value => messages.push(value) }), 143);
  assert(!messages.includes('RUN never'));
  rmSync(messages.find(line => line.startsWith('Logs: ')).slice(6), { recursive: true, force: true });
});
