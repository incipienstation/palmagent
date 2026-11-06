#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BundleIdentitySchema, StandaloneArtifactSchema, StandaloneTargetSchema, versionAtLeast } from '../packages/shared/src/standalone.ts';
import { sha256File, inspectReleaseArchive } from '../apps/server/src/platform/filesystem/release-artifact.ts';
import { copyRuntimeDependencies, filesUnder } from './lib/portable-dependencies.mjs';
import { DISTRIBUTION } from './lib/product.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

export function inspectElfRequirements(directory, minimum = '2.35') {
  const libraries = new Set();
  for (const path of filesUnder(directory)) {
    // Reading four bytes through readelf is cheap relative to bundling and catches
    // executables without an extension as well as every .node/.so dependency.
    if (readFileSync(path).subarray(0, 4).toString('hex') !== '7f454c46') continue;
    const symbols = run('readelf', ['--version-info', path]);
    for (const match of symbols.matchAll(/\bGLIBC_(\d+\.\d+(?:\.\d+)?)/g)) {
      if (!versionAtLeast(minimum, match[1])) throw new Error(`ELF requires glibc ${match[1]}, above ${minimum}: ${path.split('/').at(-1)}`);
    }
    for (const match of run('readelf', ['--dynamic', path]).matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)) libraries.add(match[1]);
  }
  return [...libraries].sort();
}

export function buildStandalone({ target = `linux-${process.arch}-glibc`, pkg = join(root, 'build/pkg'), output = join(root, 'build/standalone'), rebuild = true } = {}) {
  StandaloneTargetSchema.parse(target);
  if (process.platform !== 'linux' || target !== `linux-${process.arch}-glibc`) throw new Error('Build and smoke-test standalone on its native Linux architecture');
  const nodeVersion = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (process.versions.node !== nodeVersion) throw new Error('Standalone packaging requires the exact .nvmrc Node version');
  const info = JSON.parse(readFileSync(join(pkg, 'build-info.json'), 'utf8'));
  const product = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  if (info.version !== product.version || info.dirty !== false || !/^[a-f0-9]{40}$/.test(info.sourceCommit)) throw new Error('Standalone input must identify clean, exact source');
  const workspace = mkdtempSync(join(tmpdir(), 'palmagent-bundle-'));
  try {
    const nodeName = `node-v${nodeVersion}-linux-${process.arch}`;
    const archive = join(workspace, `${nodeName}.tar.gz`);
    const download = (url, file) => run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '180', '--output', file, url]);
    const checksums = join(workspace, 'SHASUMS256.txt');
    download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, checksums);
    download(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`, archive);
    const expected = readFileSync(checksums, 'utf8').split('\n').find(line => line.endsWith(`  ${nodeName}.tar.gz`))?.split(' ')[0];
    if (!expected || sha256File(archive) !== expected) throw new Error('Official Node archive integrity mismatch');
    run('tar', ['-xzf', archive, '-C', workspace]);
    const nodeRoot = join(workspace, nodeName), bundle = join(workspace, 'palmagent'), app = join(bundle, 'app');
    mkdirSync(join(bundle, 'runtime/bin'), { recursive: true });
    mkdirSync(join(bundle, 'bin')); mkdirSync(join(bundle, 'licenses'));
    cpSync(join(nodeRoot, 'bin/node'), join(bundle, 'runtime/bin/node'));
    cpSync(join(nodeRoot, 'LICENSE'), join(bundle, 'licenses/Node-LICENSE'));
    cpSync(pkg, app, { recursive: true });
    const dependencies = copyRuntimeDependencies(Object.keys(product.dependencies), join(root, 'apps/server'), join(app, 'node_modules'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ ...product, private: true, dependencies, scripts: {} }, null, 2) + '\n');
    if (rebuild) {
      // Only trusted native addons run build scripts. Node headers are already
      // present in the verified official archive; no install-time downloads.
      run(join(nodeRoot, 'bin/node'), [join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js'), 'rebuild', 'better-sqlite3', 'node-pty', '--build-from-source', '--offline'], {
        cwd: app, stdio: 'inherit', env: { ...process.env, PATH: `${nodeRoot}/bin:${process.env.PATH}`, npm_config_nodedir: nodeRoot,
          npm_config_build_from_source: 'true', CFLAGS: `-ffile-prefix-map=${workspace}=. -ffile-prefix-map=${root}=.`,
          CXXFLAGS: `-ffile-prefix-map=${workspace}=. -ffile-prefix-map=${root}=.` },
      });
      for (const name of ['better-sqlite3', 'node-pty']) {
        const build = join(app, 'node_modules', name, 'build'), release = join(build, 'Release');
        const products = join(workspace, `${name}-products`); mkdirSync(products);
        for (const file of filesUnder(release).filter(file => dirname(file) === release && (/\.(node|so)$/.test(file) || file.endsWith('/spawn-helper'))))
          cpSync(file, join(products, file.split('/').at(-1)));
        rmSync(build, { recursive: true }); mkdirSync(build); renameSync(products, release);
      }
    }
    const nativePlatform = `linux-${process.arch}`;
    for (const platform of ['linux-x64', 'linux-arm64']) if (platform !== nativePlatform) rmSync(join(app, 'daemon', platform), { recursive: true, force: true });
    const daemonPath = join(app, 'daemon/manifest.json'), daemon = JSON.parse(readFileSync(daemonPath, 'utf8'));
    daemon.artifacts = { [nativePlatform]: daemon.artifacts[nativePlatform] };
    daemon.applicationArtifacts = { [nativePlatform]: daemon.applicationArtifacts[nativePlatform] };
    writeFileSync(daemonPath, JSON.stringify(daemon, null, 2) + '\n');
    const identity = BundleIdentitySchema.parse({ schemaVersion: 1, distribution: 'standalone', version: info.version, sourceCommit: info.sourceCommit,
      target, nodeVersion, nodeAbi: process.versions.modules, minGlibc: '2.35' });
    writeFileSync(join(bundle, 'bundle.json'), JSON.stringify(identity, null, 2) + '\n');
    writeFileSync(join(bundle, 'bin/palmagent'), '#!/bin/sh\nset -eu\nself=$(readlink -f -- "$0")\nroot=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)\nexec "$root/runtime/bin/node" "$root/app/cli.js" "$@"\n', { mode: 0o755 });
    chmodSync(join(bundle, 'runtime/bin/node'), 0o755);
    const requiredLibraries = inspectElfRequirements(bundle);
    // Verify native resolution with this bundle's Node, never the builder's PATH.
    run(join(bundle, 'runtime/bin/node'), ['--input-type=commonjs', '-e', "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('select 1').get();db.close();require('node-pty');"], { cwd: app });
    const cliVersion = run(join(bundle, 'bin/palmagent'), ['--version'], { env: { ...process.env, PALMAGENT_CLI_FORWARDED: '1', NODE_OPTIONS: '', NODE_PATH: '' } }).trim();
    if (cliVersion !== product.version) throw new Error('Standalone CLI smoke test failed');
    const unpackedSize = filesUnder(bundle).reduce((total, path) => total + statSync(path).size, 0);
    mkdirSync(output, { recursive: true });
    const filename = `palmagent-${product.version}-${target}.tar.gz`, tar = join(output, filename.slice(0, -3));
    run('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '--hard-dereference', '-cf', tar, '-C', workspace, 'palmagent']);
    run('gzip', ['-n', '-6', tar]);
    const path = join(output, filename), size = statSync(path).size;
    inspectReleaseArchive(path, size, unpackedSize);
    const artifact = StandaloneArtifactSchema.parse({ target, filename, url: `${DISTRIBUTION.repositoryUrl}/releases/download/v${product.version}/${filename}`,
      sha256: sha256File(path), size, unpackedSize, minGlibc: identity.minGlibc, requiredLibraries });
    writeFileSync(join(output, `${target}.json`), JSON.stringify({ ...identity, artifact, nodeArchiveSha256: expected }, null, 2) + '\n');
    return artifact;
  } finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(buildStandalone({ target: process.argv[2] }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
