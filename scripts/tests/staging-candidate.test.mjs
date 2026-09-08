import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { checkSource, recordPackage } from '../staging-candidate.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-staging-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'develop');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'palmagent', version: '0.1.0-alpha.1' }));
  git('add', '.'); git('commit', '-m', 'base');
  const previous = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'change.txt'), 'Reviewed source\n');
  git('add', '.'); git('commit', '-m', 'advance develop');
  const commit = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/develop', commit);
  return { cwd, git, previous, commit };
}

test('accepts exact current or historical develop commits', (t) => {
  const f = fixture(t);
  assert.equal(checkSource(f.cwd, f.previous), f.previous);
  assert.equal(checkSource(f.cwd, f.commit), f.commit);
});

test('rejects branch names, abbreviated/missing SHAs, tag objects, and unmerged work', (t) => {
  const f = fixture(t);
  for (const value of ['develop', 'HEAD', f.commit.slice(0, 7), undefined, '0'.repeat(40)]) {
    assert.throws(() => checkSource(f.cwd, value));
  }
  f.git('tag', '-a', 'test-tag', '-m', 'tag object');
  assert.throws(() => checkSource(f.cwd, f.git('rev-parse', 'refs/tags/test-tag')), /commit object/);
  f.git('checkout', '-b', 'unmerged', f.previous);
  writeFileSync(join(f.cwd, 'unmerged.txt'), 'Not accepted on develop\n');
  f.git('add', '.'); f.git('commit', '-m', 'unmerged work');
  assert.throws(() => checkSource(f.cwd, f.git('rev-parse', 'HEAD')));
});

test('records the tested tarball bytes and distinguishes workflow/source commits', (t) => {
  const f = fixture(t);
  const directory = join(f.cwd, 'build/staging');
  mkdirSync(directory, { recursive: true });
  const filename = 'palmagent-0.1.0-alpha.1.tgz';
  const bytes = Buffer.from('Synthetic tested tarball');
  writeFileSync(join(directory, filename), bytes);
  const runUrl = 'https://github.com/example/project/actions/runs/123';
  const record = recordPackage(f.cwd, f.commit, f.previous, runUrl);
  assert.deepEqual(record, { commit: f.commit, workflowCommit: f.previous,
    version: '0.1.0-alpha.1', filename, sha256: createHash('sha256').update(bytes).digest('hex'), runUrl });
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'staging.json'), 'utf8')), record);
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), `${record.sha256}  ${filename}\n`);
  assert.deepEqual(readFileSync(join(directory, filename)), bytes);
  assert.throws(() => recordPackage(f.cwd, f.previous, f.commit, runUrl), /checkout/);
  writeFileSync(join(directory, 'extra.tgz'), 'Stale artifact');
  assert.throws(() => recordPackage(f.cwd, f.commit, f.previous, runUrl), /exactly one/);
});

test('workflow tools can validate and record a separate older checkout', (t) => {
  const f = fixture(t);
  const script = resolve('scripts/staging-candidate.mjs');
  const output = join(f.cwd, 'source-output');
  execFileSync(process.execPath, [script, 'check'], { cwd: f.cwd, stdio: 'pipe',
    env: { ...process.env, STAGING_COMMIT: f.previous, GITHUB_OUTPUT: output } });
  assert.equal(readFileSync(output, 'utf8'), `commit=${f.previous}\n`);
  const candidate = join(f.cwd, 'candidate');
  f.git('worktree', 'add', '--detach', candidate, f.previous);
  const directory = join(candidate, 'build/staging');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'palmagent-0.1.0-alpha.1.tgz'), 'Synthetic package');
  execFileSync(process.execPath, [script, 'record', 'candidate'], { cwd: f.cwd, stdio: 'pipe',
    env: { ...process.env, STAGING_COMMIT: f.previous, GITHUB_SHA: f.commit,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/project', GITHUB_RUN_ID: '123' } });
  const record = JSON.parse(readFileSync(join(directory, 'staging.json'), 'utf8'));
  assert.equal(record.commit, f.previous);
  assert.equal(record.workflowCommit, f.commit);
});
