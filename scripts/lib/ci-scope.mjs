import { execFileSync } from 'node:child_process';

const full = () => ({ code: true, server: true, web: true, package: true });

// Only known documentation and skill surfaces may bypass runtime checks.
const isStatic = (path) => /^(?:AGENTS|CLAUDE|README|CHANGELOG)\.md$/.test(path)
  || /^(?:docs|skills|plugins|\.harness\/skills)\/.+\.md$/.test(path)
  || /^\.(?:agents|claude)\/skills\/[a-z0-9-]+(?:\/SKILL\.md)?$/.test(path)
  || ['.claude-plugin/marketplace.json', 'plugins/claude/.claude-plugin/plugin.json',
    'plugins/codex/.agents/plugins/marketplace.json',
    'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json'].includes(path);

export function classifyChanges(paths, eventName = 'pull_request', ref = '') {
  if (eventName === 'push') return { ...full(), package: ref === 'refs/heads/develop' };
  if (eventName !== 'pull_request' || !Array.isArray(paths) || !paths.length) return full();
  const scope = { code: false, server: false, web: false, package: false };
  for (const path of paths) {
    if (isStatic(path)) continue;
    if (/(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/.test(path)) return full();
    scope.code = true;
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
