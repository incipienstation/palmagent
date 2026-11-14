import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { checkoutBusy, finishTask } from '../finish-task.mjs';

function fixture(t, { squash = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-finish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const primary = join(root, 'primary'), remote = join(root, 'remote');
  mkdirSync(primary);
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(primary, 'init', '-b', 'develop');
  writeFileSync(join(primary, '.gitignore'), '.harness/worktrees/\nbuild/\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'base');
  const base = git(primary, 'rev-parse', 'HEAD');
  git(root, 'init', '--bare', remote); git(primary, 'remote', 'add', 'origin', remote);
  git(primary, 'push', 'origin', 'develop');
  const worktree = join(primary, '.harness/worktrees/task');
  git(primary, 'worktree', 'add', worktree, '-b', 'feature/task');
  writeFileSync(join(worktree, 'task.txt'), 'task');
  git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'task');
  const headRefOid = git(worktree, 'rev-parse', 'HEAD');
  if (squash) {
    git(primary, 'merge', '--squash', 'feature/task');
    git(primary, 'commit', '-m', 'squashed task');
  } else git(primary, 'merge', '--ff-only', 'feature/task');
  const merge = git(primary, 'rev-parse', 'HEAD');
  git(primary, 'push', 'origin', 'develop');
  // Simulate the primary checkout lagging behind the remote merge.
  git(primary, 'reset', '--hard', base);
  const pr = { state: 'MERGED', baseRefName: 'develop', isCrossRepository: false, headRefName: 'feature/task', headRefOid, mergeCommit: { oid: merge } };
  const options = { cwd: primary, worktree, pr, busy: () => undefined };
  return { primary, worktree, git, options, base, merge };
}

test('preview keeps files and refs; apply fast-forwards and removes only the merged task', t => {
  const f = fixture(t);
  const preview = finishTask(f.options);
  assert(preview.every(line => line.startsWith('READY')));
  assert.equal(f.git(f.primary, 'rev-parse', 'HEAD'), f.base);
  assert(existsSync(f.worktree));
  const applied = finishTask({ ...f.options, apply: true });
  assert.equal(f.git(f.primary, 'rev-parse', 'HEAD'), f.merge);
  assert(!existsSync(f.worktree));
  assert(applied.includes('REMOVED branch feature/task'));
});

test('squash cleanup retains the branch when non-force ancestry cannot be proved', t => {
  const f = fixture(t, { squash: true });
  const reports = finishTask({ ...f.options, apply: true });
  assert(!existsSync(f.worktree));
  assert(reports.some(line => line.startsWith('RETAIN branch')));
  assert.equal(f.git(f.primary, 'rev-parse', 'feature/task'), f.options.pr.headRefOid);
});

for (const reason of ['tracked', 'untracked', 'ignored', 'later-commit', 'process', 'operation']) {
  test(`cleanup retains task with ${reason}`, t => {
    const f = fixture(t);
    if (reason === 'tracked') writeFileSync(join(f.worktree, 'task.txt'), 'changed');
    if (reason === 'untracked') writeFileSync(join(f.worktree, 'private.txt'), 'keep');
    if (reason === 'ignored') { mkdirSync(join(f.worktree, 'build')); writeFileSync(join(f.worktree, 'build/private.txt'), 'keep'); }
    if (reason === 'later-commit') f.git(f.worktree, 'commit', '--allow-empty', '-m', 'later');
    if (reason === 'process') f.options.busy = root => root === f.worktree ? 'active process' : undefined;
    if (reason === 'operation') writeFileSync(f.git(f.worktree, 'rev-parse', '--git-path', 'MERGE_HEAD'), f.base);
    const reports = finishTask({ ...f.options, apply: true });
    assert(existsSync(f.worktree));
    assert(reports.some(line => line.startsWith('RETAIN .harness/worktrees/task:')));
  });
}

for (const reason of ['dirty', 'wrong-branch', 'diverged', 'process']) {
  test(`primary ${reason} does not prevent independent safe task cleanup`, t => {
    const f = fixture(t);
    if (reason === 'dirty') {
      writeFileSync(join(f.primary, 'private.txt'), 'keep');
      f.git(f.primary, 'config', 'status.showUntrackedFiles', 'no');
    }
    if (reason === 'wrong-branch') f.git(f.primary, 'switch', '-c', 'other');
    if (reason === 'diverged') f.git(f.primary, 'commit', '--allow-empty', '-m', 'local-only');
    if (reason === 'process') f.options.busy = root => root === f.primary ? 'active build' : undefined;
    const head = f.git(f.primary, 'rev-parse', 'HEAD');
    const reports = finishTask({ ...f.options, apply: true });
    assert.equal(f.git(f.primary, 'rev-parse', 'HEAD'), head);
    assert(reports.some(line => line.startsWith('RETAIN develop:')));
    assert(!existsSync(f.worktree));
  });
}

test('rejects primary, wrong PR, and invocation inside the target before mutation', t => {
  const f = fixture(t);
  assert.throws(() => finishTask({ ...f.options, worktree: f.primary }), /registered manual/);
  assert.throws(() => finishTask({ ...f.options, cwd: f.worktree }), /outside/);
  for (const patch of [{ state: 'OPEN' }, { baseRefName: 'main' }, { headRefName: 'feature/other' }, { isCrossRepository: true }]) {
    assert.throws(() => finishTask({ ...f.options, pr: { ...f.options.pr, ...patch }, apply: true }), /PR must/);
  }
  assert.equal(f.git(f.primary, 'rev-parse', 'HEAD'), f.base);
  assert(existsSync(f.worktree));
});

test('detects a real process holding a task checkout', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { cwd: f.worktree, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  assert.match(checkoutBusy(f.worktree), /process \d+ uses checkout/);
  child.kill(); await once(child, 'close');
});


test('detects a process holding a worktree file from another cwd', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', `
    process.stdin.once('data', path => {
      require('node:fs').openSync(path.toString(), 'r');
      console.log('ready');
      setInterval(() => {}, 1000);
    });
  `], { cwd: f.primary, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  // Send the filename through stdin so only the open descriptor identifies the worktree.
  child.stdin.end(join(f.worktree, 'task.txt'));
  await once(child.stdout, 'data');
  assert.match(checkoutBusy(f.worktree), /process \d+ uses checkout/);
  const reports = finishTask({ ...f.options, apply: true, busy: checkoutBusy });
  assert(reports.some(line => line.startsWith('RETAIN .harness/worktrees/task:')));
  assert(existsSync(f.worktree));
  child.kill(); await once(child, 'close');
});
