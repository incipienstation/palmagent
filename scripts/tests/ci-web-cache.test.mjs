import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { acceptRestore, cacheKey, cacheSummary, recordBuild } from '../ci-web-cache.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'palmagent-web-cache-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const write = (name, value) => {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), value);
  };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test.invalid', ...args],
    { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-b', 'test');
  write('.gitignore', 'build/\ndist/\n.env\n.env.*\n');
  write('package.json', '{"version":"0.1.0-alpha.1"}\n');
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write('apps/web/src/main.ts', 'export const name = "app";\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const inputs = { env: { CI: 'true', ImageOS: 'ubuntu24', ImageVersion: 'image-1' },
    node: 'v24.21.0', platform: 'linux', arch: 'x64' };
  const key = () => cacheKey(cwd, inputs);
  const build = () => {
    write('apps/web/dist/index.html', '<html>fixture</html>');
    write('apps/web/dist/sw.js', 'self.fixture = true;');
    write('apps/web/dist/assets/app.js', 'export const value = 1;');
  };
  return { cwd, write, git, inputs, key, build };
}

test('content keys reuse identical trees but invalidate version, dependencies, source and unknown configuration', t => {
  const f = fixture(t);
  let previous = f.key();
  assert.match(previous, /^pr-pwa-v1-[a-f0-9]{64}$/);
  f.git('commit', '--allow-empty', '-m', 'metadata only');
  assert.equal(f.key(), previous);
  for (const [path, value] of [
    ['package.json', '{"version":"0.1.0-alpha.2"}'], ['pnpm-lock.yaml', 'lockfileVersion: 10'],
    ['apps/web/src/main.ts', 'export const name = "changed";'],
    ['apps/web/vite.config.ts', 'export default {};'], ['scripts/new-build-input.mjs', 'export const value = 1;'],
  ]) {
    f.write(path, value);
    assert.throws(f.key, /clean source/);
    f.git('add', '.'); f.git('commit', '-m', 'change build input');
    const next = f.key();
    assert.notEqual(next, previous, path);
    previous = next;
  }
});

test('runtime, image and Vite environment inputs invalidate without exposing values', t => {
  const f = fixture(t);
  const original = f.key();
  for (const override of [{ node: 'v24.22.0' }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    assert.notEqual(cacheKey(f.cwd, { ...f.inputs, ...override }), original);
  }
  for (const name of ['ImageVersion', 'ImageOS', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'API_PROXY', 'VITE_EXAMPLE', 'TZ']) {
    const next = cacheKey(f.cwd, { ...f.inputs, env: { ...f.inputs.env, [name]: 'changed-value' } });
    assert.notEqual(next, original, name);
    assert(!next.includes('changed-value'));
  }
  assert.equal(cacheKey(f.cwd, { ...f.inputs, env: { ...f.inputs.env, GITHUB_RUN_ID: '2' } }), original);
  f.write('apps/web/.env.production.local', 'VITE_EXAMPLE=local-value\n');
  const dotenv = f.key();
  assert.notEqual(dotenv, original);
  f.write('apps/web/.env.production.local', 'VITE_EXAMPLE=updated-value\n');
  assert.notEqual(f.key(), dotenv);
});

test('exact restored output stays reusable without putting its receipt in the PWA', t => {
  const f = fixture(t);
  f.build();
  recordBuild(f.cwd, f.key());
  assert.equal(acceptRestore(f.cwd, f.key(), 'true'), 'hit');
  assert(existsSync(join(f.cwd, 'apps/web/dist/index.html')));
  assert(!existsSync(join(f.cwd, 'apps/web/dist/ci-web-cache.json')));
});

test('missing, partial and failed restores discard stale output before rebuilding', t => {
  const f = fixture(t);
  for (const hit of [undefined, '', 'false']) {
    f.build(); recordBuild(f.cwd, f.key());
    assert.equal(acceptRestore(f.cwd, f.key(), hit), 'miss');
    assert(!existsSync(join(f.cwd, 'apps/web/dist')));
    assert(!existsSync(join(f.cwd, 'build/ci-web-cache.json')));
  }
});

test('wrong keys, corrupt receipts, changed, extra, missing and linked files fall back to a fresh build', t => {
  const f = fixture(t);
  const mutate = [
    () => recordBuild(f.cwd, `pr-pwa-v1-${'f'.repeat(64)}`),
    () => f.write('build/ci-web-cache.json', '{broken'),
    () => rmSync(join(f.cwd, 'build/ci-web-cache.json')),
    () => f.write('apps/web/dist/assets/app.js', 'changed output'),
    () => f.write('apps/web/dist/unexpected.js', 'extra output'),
    () => rmSync(join(f.cwd, 'apps/web/dist/sw.js')),
    () => { rmSync(join(f.cwd, 'apps/web/dist/index.html')); symlinkSync('../src/main.ts', join(f.cwd, 'apps/web/dist/index.html')); },
  ];
  for (const change of mutate) {
    f.build(); recordBuild(f.cwd, f.key()); change();
    assert.equal(acceptRestore(f.cwd, f.key(), 'true'), 'invalid');
    assert(!existsSync(join(f.cwd, 'apps/web/dist')));
    assert(existsSync(join(f.cwd, 'apps/web/src/main.ts')));
    f.build(); recordBuild(f.cwd, f.key());
    assert.equal(acceptRestore(f.cwd, f.key(), 'true'), 'hit');
  }
});

test('the build command records fresh output, reports duration, and does not hide build failures', t => {
  const f = fixture(t);
  const bin = join(f.cwd, 'build/bin');
  f.write('build/bin/pnpm', `#!/usr/bin/env node
    const fs = require('node:fs');
    if (process.env.FAIL_BUILD) process.exit(42);
    if (process.argv[2] !== 'web:build') process.exit(43);
    fs.mkdirSync('apps/web/dist', { recursive: true });
    fs.writeFileSync('apps/web/dist/index.html', '<html>built</html>');
    fs.writeFileSync('apps/web/dist/sw.js', 'self.built = true;');
  `);
  chmodSync(join(bin, 'pnpm'), 0o755);
  const cli = resolve('scripts/ci-web-cache.mjs');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PWA_CACHE_KEY: f.key(),
    GITHUB_OUTPUT: join(f.cwd, 'build/output') };
  execFileSync(process.execPath, [cli, 'build'], { cwd: f.cwd, env, stdio: 'pipe' });
  assert.equal(acceptRestore(f.cwd, f.key(), 'true'), 'hit');
  assert.match(readFileSync(env.GITHUB_OUTPUT, 'utf8'), /seconds=\d+\.\d/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'build'], {
    cwd: f.cwd, env: { ...env, FAIL_BUILD: '1' }, stdio: 'pipe',
  }), { status: 1 });
});

test('telemetry distinguishes hits, invalid caches and restore failures without accepting arbitrary summary text', () => {
  assert.match(cacheSummary({ CACHE_STATE: 'hit', RESTORE_OUTCOME: 'success', BUILD_OUTCOME: 'skipped' }), /hit \| success \| skipped/);
  assert.match(cacheSummary({ CACHE_STATE: 'invalid', RESTORE_OUTCOME: 'success', BUILD_OUTCOME: 'success', BUILD_SECONDS: '25.2' }), /invalid \| success \| success \| 25.2/);
  assert.match(cacheSummary({ CACHE_STATE: 'miss', RESTORE_OUTCOME: 'failure', BUILD_OUTCOME: 'success', BUILD_SECONDS: '26.1' }), /miss \| failure \| success \| 26.1/);
  assert(!cacheSummary({ CACHE_STATE: '<unsafe>', BUILD_SECONDS: '<unsafe>' }).includes('<unsafe>'));
});
