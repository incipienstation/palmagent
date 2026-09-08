import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { changedPaths, classifyChanges } from '../lib/ci-scope.mjs';

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
