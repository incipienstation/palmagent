#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareVersions, versionPolicy } from './lib/release-version.mjs';

const manifests = [
  'package.json',
  'plugins/claude/.claude-plugin/plugin.json',
  'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json',
];

export function prepareVersion(cwd, version, { apply = false, development = false } = {}) {
  const policy = versionPolicy(version);
  const values = manifests.map((path) => JSON.parse(readFileSync(join(cwd, path), 'utf8')));
  const current = versionPolicy(values[0].version).version;
  if (values.some((p) => p.version !== current)) throw new Error('Existing product versions are out of sync');
  if (compareVersions(version, current) < 0) throw new Error('Version must not move backwards');
  if (development && policy.channel !== 'next') throw new Error('The next development version must be a prerelease');
  const changelogPath = join(cwd, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  let updated = changelog;
  if (!development) {
    if (changelog.split('\n').some((line) => line.trim() === `## ${version}`)) throw new Error('Release notes for this version already exist');
    const unreleased = /^## Unreleased\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
    if (!unreleased || !unreleased[1].trim()) throw new Error('Add reviewed changes under ## Unreleased first');
    updated = changelog.replace(unreleased[0], `## Unreleased\n\n## ${version}\n\n${unreleased[1].trim()}\n\n`);
  }
  const proposal = { current, proposed: version, ...policy, development, files: [...manifests, ...(!development ? ['CHANGELOG.md'] : [])], changelog: updated };
  // The caller supplies the policy-selected version; this command never selects one,
  // commits, tags, publishes, or deploys. Validate all inputs before any write.
  if (apply) {
    manifests.forEach((path, i) => writeFileSync(join(cwd, path), JSON.stringify({ ...values[i], version }, null, 2) + '\n'));
    if (!development) writeFileSync(changelogPath, updated);
  }
  return proposal;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [version, ...flags] = process.argv.slice(2);
    if (flags.some((f) => !['--apply', '--development'].includes(f))) throw new Error('Usage: pnpm release:prepare <version> [--development] [--apply]');
    console.log(JSON.stringify(prepareVersion(process.cwd(), version, { apply: flags.includes('--apply'), development: flags.includes('--development') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
