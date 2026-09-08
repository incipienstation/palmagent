import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { versionPolicy } from './release-version.mjs';

export const hashFile = (path, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(readFileSync(path)).digest(encoding);

export function inspectPackage(path, { version, commit, publishable = false, allowLegacy = false } = {}) {
  path = resolve(path);
  if (!statSync(path).isFile() || statSync(path).size > 128 * 1024 * 1024) throw new Error('Expected a package tarball under 128 MiB');
  const tar = (...args) => execFileSync('tar', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const names = tar('-tzf', path).trim().split('\n');
  const unique = new Set(names);
  if (unique.size !== names.length || names.some((name) => !/^package\/[\w@./-]*$/.test(name) || name.split('/').includes('..'))) throw new Error('Unsafe or duplicate package entry');
  // npm packages produced here contain regular files and directories only.
  // Reject links/devices before inspecting or installing an operator artifact.
  if (tar('-tvzf', path).trim().split('\n').some((line) => !['-', 'd'].includes(line[0]))) throw new Error('Package contains links or special files');
  const read = (name) => tar('-xOzf', path, `package/${name}`);
  const pkg = JSON.parse(read('package.json'));
  if (pkg.name !== 'palmagent' || (version && pkg.version !== version)) throw new Error('Package name or version mismatch');
  versionPolicy(pkg.version);
  if (pkg.publishConfig?.registry && pkg.publishConfig.registry !== 'https://registry.npmjs.org') throw new Error('Unexpected publication registry');
  if (publishable && pkg.private !== false) throw new Error('Package is not publishable');
  if (Object.keys(pkg.scripts ?? {}).some((name) => name !== 'prepublishOnly')) throw new Error('Unexpected package lifecycle script');
  let info = null;
  if (unique.has('package/build-info.json')) {
    info = JSON.parse(read('build-info.json'));
    if (!/^[a-f0-9]{40}$/.test(info.sourceCommit ?? '') || info.version !== pkg.version || info.dirty !== false) throw new Error('Package must identify a clean source commit');
    if (commit && info.sourceCommit !== commit) throw new Error('Package source commit mismatch');
  } else if (!allowLegacy) throw new Error('Package has no source identity');
  const files = {};
  for (const name of names.filter((name) => !name.endsWith('/'))) {
    const bytes = execFileSync('tar', ['-xOzf', path, name], { maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    files[name.slice('package/'.length)] = createHash('sha256').update(bytes).digest('hex');
  }
  for (const name of ['cli.js', 'server.js', 'runner-daemon.js', 'web/index.html']) {
    if (!files[name]) throw new Error(`Package missing ${name}`);
  }
  return { version: pkg.version, sourceCommit: info?.sourceCommit ?? null, sha256: hashFile(path), files };
}
