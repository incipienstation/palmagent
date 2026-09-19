import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { changedPaths, classifyChanges, classifyPullRequest } from '../lib/ci-scope.mjs';

const all = { code: true, server: true, web: true, package: true };
const none = { code: false, server: false, web: false, package: false };

test('documentation and repository/operator skills need no dependency or runtime work', () => {
  assert.deepEqual(classifyChanges(['AGENTS.md', 'CLAUDE.md', 'README.md', 'CHANGELOG.md',
    'docs/RELEASING.md', '.harness/skills/ship/SKILL.md', '.agents/skills/ship',
    '.claude/skills/ship', 'skills/doctor/SKILL.md', 'plugins/claude/skills/doctor/SKILL.md',
    'plugins/codex/README.md', 'plugins/claude/.claude-plugin/plugin.json']), none);
});

test('server, web, and shared changes select their runtime surfaces', () => {
  assert.deepEqual(classifyChanges(['apps/server/src/server.ts']), { ...none, code: true, server: true });
  assert.deepEqual(classifyChanges(['apps/web/src/app.tsx']), { ...none, code: true, web: true });
  assert.deepEqual(classifyChanges(['packages/shared/src/types.ts']), { ...all, package: false });
  assert.deepEqual(classifyChanges(['README.md', 'apps/web/src/app.tsx']), { ...none, code: true, web: true });
});

test('packaging, dependency, workflow, and unknown changes cannot take the static shortcut', () => {
  for (const path of ['package.json', 'pnpm-lock.yaml', 'apps/server/package.json',
    'apps/web/package.json', 'scripts/build-pkg.ts', 'scripts/pkg-smoke.mjs',
    'scripts/lib/ci-scope.mjs', '.github/workflows/ci.yml', 'nx.json', '.gitignore',
    'LICENSE', '.claude/hooks/check.sh', '.harness/skills/ship/scripts/cleanup.sh', 'new-package/file.ts']) {
    assert.deepEqual(classifyChanges([path]), all, path);
  }
  assert.equal(classifyChanges(['apps/server/src/cli/index.ts']).package, true);
  assert.equal(classifyChanges(['packages/shared/src/branding.ts']).package, true);
});

test('missing scope or an unexpected event cannot select the static shortcut', () => {
  for (const paths of [undefined, []]) assert.deepEqual(classifyChanges(paths), all);
  assert.deepEqual(classifyChanges(['README.md'], 'push'), all);
  assert.deepEqual(classifyChanges(['README.md'], 'unexpected-event'), all);
});

test('complete PR diff retains earlier code changes and both sides of renames', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-ci-scope-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), content);
  };
  git('init', '-b', 'base');
  write('README.md', 'Initial documentation\n');
  write('apps/server/old.ts', 'reusable source\n');
  git('add', '.'); git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature');
  write('apps/web/new.ts', 'new implementation\n');
  git('add', '.'); git('commit', '-m', 'implementation');
  write('README.md', 'Documentation follow-up\n');
  git('add', '.'); git('commit', '-m', 'documentation');
  const head = git('rev-parse', 'HEAD');
  assert.deepEqual(changedPaths(cwd, base, head).sort(), ['README.md', 'apps/web/new.ts']);
  assert.equal(classifyChanges(changedPaths(cwd, base, head)).web, true);
  git('mv', 'apps/server/old.ts', 'docs.md');
  git('commit', '-m', 'rename');
  assert(changedPaths(cwd, base, git('rev-parse', 'HEAD')).includes('apps/server/old.ts'));
  git('checkout', 'base');
  write('base-only.txt', 'Base advanced independently\n');
  git('add', '.'); git('commit', '-m', 'advance base');
  assert.deepEqual(changedPaths(cwd, git('rev-parse', 'HEAD'), head).sort(), ['README.md', 'apps/web/new.ts']);
  assert.throws(() => changedPaths(cwd, '--invalid', head), /immutable/);
});

test('scope command fails closed when event metadata or commit history is unavailable', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-ci-fallback-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const output = join(cwd, 'output');
  const event = join(cwd, 'event.json');
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } }));
  execFileSync(process.execPath, [resolve('scripts/ci-scope.mjs')], {
    cwd, stdio: 'pipe', env: { ...process.env, GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output },
  });
  assert.equal(readFileSync(output, 'utf8'), 'code=true\nserver=true\nweb=true\npackage=true\n');
});


test('only synchronized version fields and release notes qualify for preparation checks', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-ci-versions-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const manifests = ['package.json', 'plugins/claude/.claude-plugin/plugin.json',
    'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json'];
  const write = (path, value) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), JSON.stringify(value));
  };
  const prepare = (version) => {
    for (const path of manifests) write(path, { name: 'palmagent', version, scripts: { test: 'node --test' } });
    write('CHANGELOG.md', 'Reviewed release notes');
  };
  const commit = () => { git('add', '.'); git('commit', '--allow-empty', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  git('init', '-b', 'base');
  prepare('0.1.0-alpha.1');
  const base = commit();
  prepare('0.1.0-alpha.2');
  const prepared = commit();
  assert.deepEqual(classifyPullRequest(cwd, base, prepared), none);
  // A later documentation commit must not hide an earlier dependency change.
  for (const change of [
    () => write('package.json', { name: 'palmagent', version: '0.1.0-alpha.2', scripts: { test: 'exit 0' } }),
    () => write('package.json', { name: 'palmagent', version: '0.1.0-alpha.2', dependencies: { example: '*' } }),
    () => write(manifests[1], { name: 'different', version: '0.1.0-alpha.2', scripts: { test: 'node --test' } }),
    () => write(manifests[1], { name: 'palmagent', version: '0.1.0-alpha.3', scripts: { test: 'node --test' } }),
    () => write('pnpm-lock.yaml', 'changed'),
    () => write('apps/web/src/app.tsx', 'changed'),
    () => chmodSync(join(cwd, 'package.json'), 0o755),
    () => prepare('invalid'),
    () => rmSync(join(cwd, manifests[1])),
  ]) {
    git('reset', '--hard', prepared);
    git('clean', '-fd');
    change();
    commit();
    write('CHANGELOG.md', 'Later notes');
    const head = commit();
    assert.notDeepEqual(classifyPullRequest(cwd, base, head), none);
  }
  git('reset', '--hard', prepared);
  git('clean', '-fd');
  writeFileSync(join(cwd, 'package.json'), '{invalid');
  assert.deepEqual(classifyPullRequest(cwd, base, commit()), all);
});
