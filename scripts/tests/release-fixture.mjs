import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preparationFiles } from '../lib/preview-plan.mjs';

export function releaseFixture(t, version = '0.1.0-alpha.1') {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Release Test', GIT_COMMITTER_NAME: 'Release Test',
      GIT_AUTHOR_EMAIL: 'release-test@localhost', GIT_COMMITTER_EMAIL: 'release-test@localhost', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const put = (name, value) => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value); };
  const commit = () => { git('add', '.'); git('commit', '-m', 'Fixture change'); return git('rev-parse', 'HEAD'); };
  git('init', '-b', version.includes('-') ? 'develop' : 'main');
  for (const path of preparationFiles.filter((path) => path.endsWith('.json'))) put(path, JSON.stringify({ name: 'palmagent', version }));
  put('CHANGELOG.md', `# Changes\n\n## Unreleased\n\n## ${version}\n\nRelease notes.\n`);
  put('apps/server/src/index.ts', 'export const value = 1;\n');
  const source = commit();
  git('update-ref', `refs/remotes/origin/${version.includes('-') ? 'develop' : 'main'}`, source);
  return { root, git, put, commit, source };
}
