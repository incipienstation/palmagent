#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { extractReleaseArchive, sha256File } from '../apps/server/src/platform/filesystem/release-artifact.ts';

// Run the exact archive in a baseline image without Node, npm, or network access.
const directory = resolve(process.argv[2] ?? 'build/standalone');
const target = `linux-${process.arch}-glibc`;
const report = JSON.parse(readFileSync(join(directory, `${target}.json`), 'utf8'));
const artifact = report.artifact;
const archive = join(directory, artifact.filename);
if (sha256File(archive) !== artifact.sha256) throw new Error('Smoke archive checksum differs');
const scratch = mkdtempSync(join(tmpdir(), 'palmagent-portable-smoke-'));
try {
  extractReleaseArchive(archive, scratch, artifact.size, artifact.unpackedSize);
  writeFileSync(join(scratch, 'Dockerfile'), 'FROM ubuntu:22.04\nRUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*\n');
  execFileSync('docker', ['build', '-t', `palmagent-portable-smoke-${process.arch}`, scratch], { stdio: 'inherit' });
  const probe = `
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const { createRequire } = require('node:module');
    const req = createRequire('/bundle/app/package.json');
    const identity = req('../bundle.json');
    assert.equal(process.versions.node, identity.nodeVersion);
    assert.equal(process.versions.modules, identity.nodeAbi);
    assert.equal(process.report.getReport().header.glibcVersionRuntime, '2.35');
    for (const command of ['node', 'npm', 'pnpm']) assert.throws(() => execFileSync('/bin/sh', ['-c', 'command -v ' + command]));
    const db = new (req('better-sqlite3'))(':memory:');
    assert.equal(db.prepare('select 42 as n').get().n, 42); db.close();
    for (const name of ['palmagentd', 'palmagent-runtime']) {
      const result = JSON.parse(execFileSync('/bundle/app/daemon/linux-' + process.arch + '/' + name, ['--version']));
      assert.equal(result.version, identity.version); assert.equal(result.sourceCommit, identity.sourceCommit);
    }
    assert.equal(execFileSync('/bundle/bin/palmagent', ['--version'], {encoding:'utf8'}).trim(), identity.version);
    const terminal = req('node-pty').spawn('/bin/sh', ['-c', 'printf portable-pty'], {env: process.env});
    let output = ''; terminal.onData(value => output += value);
    const timeout = setTimeout(() => process.exit(1), 5000);
    terminal.onExit(({exitCode}) => { clearTimeout(timeout); assert.equal(exitCode, 0); assert.match(output, /portable-pty/); console.log('Offline standalone smoke passed: ' + identity.target); });
  `;
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '-e', 'PALMAGENT_CLI_FORWARDED=1', '-e', 'HOME=/tmp',
    '-v', `${join(scratch, 'palmagent')}:/bundle:ro`, `palmagent-portable-smoke-${process.arch}`,
    '/bundle/runtime/bin/node', '--input-type=commonjs', '-e', probe], { stdio: 'inherit', timeout: 30_000 });
} finally { rmSync(scratch, { recursive: true, force: true }); }
