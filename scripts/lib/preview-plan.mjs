import { execFileSync } from 'node:child_process';
import { compareVersions, RELEASE_VERSION, versionPolicy } from './release-version.mjs';

export const preparationFiles = [
  'package.json', 'plugins/claude/.claude-plugin/plugin.json',
  'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json', 'CHANGELOG.md',
];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Release eligibility is independent of CI scope: shipped operator Markdown is product code.
export function isProductPath(path) {
  if (/^(?:apps|packages)\//.test(path) && (path.endsWith('.md') || /(?:^|\/)docs\//.test(path))) return false;
  if (/(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^/]+$/.test(path)) return false;
  if (/(?:^|\/)(?:playwright|vitest)\.config\.[^/]+$/.test(path)) return false;
  if (['apps/server/scripts/cli-render-check.ts', 'apps/web/scripts/test-sw-update.mjs'].includes(path)) return false;
  return /^(?:apps\/(?:server|web)\/|packages\/shared\/|skills\/|plugins\/claude\/|plugins\/codex\/plugins\/palmagent\/)/.test(path)
    || ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'LICENSE',
      '.claude-plugin/marketplace.json', 'plugins/codex/.agents/plugins/marketplace.json',
      'scripts/build-pkg.ts'].includes(path);
}

function normalizedJson(path, value, { ignoreScripts = true } = {}) {
  const json = JSON.parse(value);
  if (preparationFiles.includes(path)) delete json.version;
  // Root command aliases do not ship. Dependency and toolchain changes still count.
  if (ignoreScripts && path === 'package.json') delete json.scripts;
  const sorted = (value) => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(json));
}

export function productChanges(cwd, base, head) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  assert(/^[a-f0-9]{40}$/.test(head) && (base === null || /^[a-f0-9]{40}$/.test(base)), 'Expected immutable source commits');
  if (base) git('merge-base', '--is-ancestor', base, head);
  const paths = (base ? git('diff', '--name-only', '--no-renames', '-z', base, head, '--')
    : git('ls-tree', '-r', '--name-only', '-z', head)).split('\0').filter(Boolean);
  return paths.filter((path) => {
    if (!isProductPath(path)) return false;
    if (base && (path === 'package.json' || preparationFiles.includes(path))) {
      let before, after;
      try { before = git('show', `${base}:${path}`); after = git('show', `${head}:${path}`); }
      catch { return true; } // Added/deleted manifests are product changes.
      return normalizedJson(path, before) !== normalizedJson(path, after);
    }
    return true;
  });
}

export function nextPreviewVersion(current, reserved) {
  versionPolicy(current);
  assert(current.includes('-'), 'Declare a prerelease version on develop before preparing Preview');
  const [base, suffix] = current.split('-');
  const [stage, number] = suffix.split('.');
  const versions = reserved.map((value) => value.replace(/^v/, '')).filter((value) => RELEASE_VERSION.test(value));
  const prefix = `${base}-${stage}.`;
  const highest = Math.max(-1, ...versions.filter((value) => value.startsWith(prefix)).map((value) => Number(value.slice(prefix.length))));
  const sequence = Math.max(Number(number), highest + 1);
  assert(Number.isSafeInteger(sequence), 'Preview version sequence exhausted');
  const version = `${prefix}${sequence}`;
  assert(!versions.some((value) => compareVersions(value, version) >= 0), 'Selected Preview lane is behind an existing release; advance its base or stage');
  return version;
}

export function assertPreparation(cwd, base, head, version) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  assert(/^[a-f0-9]{40}$/.test(base) && /^[a-f0-9]{40}$/.test(head), 'Invalid preparation identity');
  assert(git('rev-parse', `${head}^`) === base, 'Preparation must be one commit on its selected source');
  const paths = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
  assert(paths.length > 0 && paths.every((path) => preparationFiles.includes(path)), 'Preparation changed files outside release metadata');
  assert(productChanges(cwd, base, head).length === 0, 'Preparation changed product contents');
  for (const path of preparationFiles.filter((path) => path.endsWith('.json'))) {
    assert(JSON.parse(git('show', `${head}:${path}`)).version === version, 'Preparation versions differ');
    assert(normalizedJson(path, git('show', `${base}:${path}`), { ignoreScripts: false })
      === normalizedJson(path, git('show', `${head}:${path}`), { ignoreScripts: false }), 'Preparation changed manifest fields other than version');
  }
  const changelog = git('show', `${head}:CHANGELOG.md`);
  assert(changelog.includes(`\n## ${version}\n`), 'Preparation has no versioned release notes');
}
