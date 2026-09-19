import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { versionPolicy } from './release-version.mjs';

const full = () => ({ types: true, tooling: true, server: true, web: true, package: true });

// pkg:check covers these tests and fixtures; none are runtime inputs. Keep
// new/unknown tooling paths on the full gate until their consumers are reviewed.
const toolingTests = new Set([
  'ci-results.test.mjs', 'ci-scope.test.mjs', 'deploy-staging.test.mjs',
  'local-verification.test.mjs', 'package-artifact.test.mjs', 'package-fixture.mjs',
  'pkg-smoke.test.mjs', 'preview-release.test.mjs', 'release-candidate.test.mjs',
  'release-finalize.test.mjs', 'release-fixture.mjs', 'release-github.test.mjs',
  'release-publish.test.mjs', 'release-tag.test.mjs', 'release-timing.test.mjs',
  'release-version.test.mjs', 'repository-skills.test.mjs', 'stable-prepare.test.mjs',
  'staging-candidate.test.mjs', 'sync-skills.test.mjs', 'verify-candidate.test.mjs',
].map(name => `scripts/tests/${name}`));

// Only known documentation and skill surfaces may bypass runtime checks.
const isStatic = (path) => /^(?:AGENTS|CLAUDE|README|CHANGELOG)\.md$/.test(path)
  || /^(?:apps\/(?:server|web)|packages\/shared)\/README\.md$/.test(path)
  || /^(?:docs|skills|plugins|\.harness\/skills)\/.+\.md$/.test(path)
  || /^\.(?:agents|claude)\/skills\/[a-z0-9-]+(?:\/SKILL\.md)?$/.test(path)
  || ['.claude-plugin/marketplace.json', 'plugins/claude/.claude-plugin/plugin.json',
    'plugins/codex/.agents/plugins/marketplace.json',
    'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json'].includes(path);

export function classifyChanges(paths, eventName = 'pull_request') {
  if (eventName !== 'pull_request' || !Array.isArray(paths) || !paths.length) return full();
  const scope = { types: false, tooling: false, server: false, web: false, package: false };
  for (const path of paths) {
    if (isStatic(path)) continue;
    if (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(path)) return full();
    if (toolingTests.has(path)) { scope.tooling = true; continue; }
    // Browser cases/snapshots are outside the typecheck projects and are not
    // packaging/CLI inputs. Other source paths retain both checks conservatively.
    if (!path.startsWith('apps/web/tests/e2e/')) scope.types = scope.tooling = true;
    if (path.startsWith('apps/server/')) {
      scope.server = true;
      if (path.startsWith('apps/server/src/cli/')) scope.package = true;
    } else if (path.startsWith('apps/web/')) {
      scope.web = true;
    } else if (path.startsWith('packages/shared/')) {
      scope.server = scope.web = true;
      if (path === 'packages/shared/src/branding.ts') scope.package = true;
    } else {
      // Packaging, workflow, tooling, root config, and unknown paths get the full gate.
      return full();
    }
  }
  return scope;
}

export function changedPaths(cwd, base, head) {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
    throw new Error('Expected immutable base and head commits');
  }
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const ancestor = git(['merge-base', base, head]).trim();
  // Read the complete PR diff, including both sides of renames, without API path limits.
  return git(['diff', '--name-only', '--no-renames', '-z', ancestor, head, '--']).split('\0').filter(Boolean);
}

// A release preparation changes only versions and release notes. Inspect the
// complete committed diff; branch names and the latest commit are not evidence.
export function classifyPullRequest(cwd, base, head) {
  const paths = changedPaths(cwd, base, head);
  const manifests = ['package.json', 'plugins/claude/.claude-plugin/plugin.json',
    'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json'];
  if (!paths.includes('package.json') || paths.some((path) => path !== 'CHANGELOG.md' && !manifests.includes(path))) {
    return classifyChanges(paths);
  }
  try {
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const ancestor = git(['merge-base', base, head]).trim();
    let versions;
    for (const path of manifests) {
      const before = JSON.parse(git(['show', `${ancestor}:${path}`]));
      const after = JSON.parse(git(['show', `${head}:${path}`]));
      versionPolicy(before.version);
      versionPolicy(after.version);
      versions ??= [before.version, after.version];
      if (!isDeepStrictEqual([before.version, after.version], versions) || before.version === after.version) {
        return full();
      }
      delete before.version;
      delete after.version;
      if (!isDeepStrictEqual(before, after)) return full();
      if (git(['ls-tree', ancestor, '--', path]).split(' ')[0] !== '100644'
        || git(['ls-tree', head, '--', path]).split(' ')[0] !== '100644') return full();
    }
    return { types: false, tooling: false, server: false, web: false, package: false };
  } catch {
    return full();
  }
}
