import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { localScope, runVerification, verificationSteps } from '../lib/local-verification.mjs';

const full = { code: true, server: true, web: true, package: true };
const none = { code: false, server: false, web: false, package: false };

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-local-verification-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
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

test('runner stops at failure, preserves private logs, and does not echo child output', t => {
  const { cwd } = fixture(t), messages = [];
  const report = value => {
    messages.push(value);
    if (value.startsWith('Logs: ')) t.after(() => rmSync(value.slice(6), { recursive: true, force: true }));
  };
  const steps = [
    { id: 'first', command: process.execPath, args: ['-e', 'console.log("child-output"); process.exit(7)'] },
    { id: 'later', command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("unexpected", "ran")'] },
  ];
  assert.equal(runVerification(steps, { cwd, report }), 7);
  assert(!existsSync(join(cwd, 'unexpected')));
  assert(!messages.join('\n').includes('child-output'));
  const logs = messages.find(value => value.startsWith('Logs: ')).slice(6);
  assert.match(readFileSync(join(logs, 'first.log'), 'utf8'), /child-output/);
  assert.equal(statSync(join(logs, 'first.log')).mode & 0o777, 0o600);
  assert.equal(statSync(logs).mode & 0o777, 0o700);
});

test('runner completes source steps but cannot run package steps without the denylist', t => {
  const { cwd } = fixture(t), messages = [];
  const report = value => {
    messages.push(value);
    if (value.startsWith('Logs: ')) t.after(() => rmSync(value.slice(6), { recursive: true, force: true }));
  };
  const step = { id: 'success', command: process.execPath, args: ['-e', 'process.exit(0)'] };
  assert.equal(runVerification([step], { cwd, report }), 0);
  assert(messages.some(value => value.startsWith('PASS: 1')));
  for (const denylist of ['', ' ,\n']) {
    messages.length = 0;
    assert.equal(runVerification([step, { ...step, id: 'package', env: { REQUIRE_LEAK_DENYLIST: 'true' } }],
      { cwd, report, env: { LEAK_DENYLIST: denylist } }), 1);
    assert(messages.some(value => value.startsWith('PASS success')));
    assert(messages.some(value => value.startsWith('BLOCKED package')));
    assert(!messages.includes('RUN package'));
  }
  assert.equal(runVerification([{
    ...step, id: 'package', env: { REQUIRE_LEAK_DENYLIST: 'true' },
    args: ['-e', 'if (!process.env.LEAK_DENYLIST || process.env.REQUIRE_LEAK_DENYLIST !== "true") process.exit(9)'],
  }], { cwd, report, env: { LEAK_DENYLIST: 'fixture-denied-phrase' } }), 0);
  assert.equal(runVerification([{ ...step, command: join(cwd, 'missing-executable') }], { cwd, report }), 1);
});

test('CLI rejects unknown options without starting verification', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), '--unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.equal(result.stdout, '');
});
