import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = value => createHash('sha256').update(value).digest('hex');
const dist = 'apps/web/dist';
const receipt = 'build/ci-web-cache.json';
const validKey = key => /^pr-pwa-v1-[a-f0-9]{64}$/.test(key ?? '');

export function cacheKey(cwd, { env = process.env, node = process.version,
  platform = process.platform, arch = process.arch } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert(!git('status', '--porcelain', '--untracked-files=normal'), 'PWA cache requires a clean source checkout');
  // Conservatively include every tracked input, including root version, lockfiles,
  // build scripts and unknown future configuration. Commit metadata is not an input.
  const tree = git('rev-parse', 'HEAD^{tree}');
  const names = ['API_PROXY', 'CI', 'NODE_ENV', 'NODE_OPTIONS', 'SOURCE_DATE_EPOCH',
    'TZ', 'LANG', 'LC_ALL', 'LC_CTYPE', 'BROWSERSLIST', 'BROWSERSLIST_ENV', 'TAILWIND_MODE',
    'ImageOS', 'ImageVersion', ...Object.keys(env).filter(name => name.startsWith('VITE_'))];
  const environment = [...new Set(names)].sort().map(name => [name, env[name] ?? null]);
  // Vite can read ignored dotenv files too; hash their bytes without exposing values.
  const dotenv = ['', 'apps/web'].flatMap(directory =>
    ['.env', '.env.local', '.env.production', '.env.production.local'].map(name => {
      const path = join(directory, name);
      return [path, existsSync(join(cwd, path)) ? digest(readFileSync(join(cwd, path))) : null];
    }));
  return `pr-pwa-v1-${digest(JSON.stringify({ tree, node, platform, arch, environment, dotenv }))}`;
}

function outputFiles(cwd) {
  const root = join(cwd, dist);
  const files = [];
  const visit = (directory, prefix = '') => {
    assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'Invalid PWA cache directory');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, relative);
      else {
        assert(stat.isFile() && !stat.isSymbolicLink(), 'Invalid PWA cache file');
        files.push([relative, digest(readFileSync(path))]);
      }
    }
  };
  visit(root);
  for (const required of ['index.html', 'sw.js']) {
    assert(files.some(([name]) => name === required), `PWA output is missing ${required}`);
  }
  return files;
}

export function recordBuild(cwd, key) {
  assert(validKey(key), 'Invalid PWA cache key');
  const files = outputFiles(cwd);
  mkdirSync(join(cwd, 'build'), { recursive: true });
  writeFileSync(join(cwd, receipt), JSON.stringify({ schema: 1, key, files }) + '\n');
}

export function acceptRestore(cwd, key, hit) {
  assert(validKey(key), 'Invalid PWA cache key');
  let state = 'miss';
  if (hit === 'true') {
    try {
      assert(lstatSync(join(cwd, receipt)).isFile() && !lstatSync(join(cwd, receipt)).isSymbolicLink());
      const saved = JSON.parse(readFileSync(join(cwd, receipt), 'utf8'));
      assert(saved.schema === 1 && saved.key === key);
      assert.deepEqual(saved.files, outputFiles(cwd));
      return 'hit';
    } catch { state = 'invalid'; }
  }
  // A partial restore, corrupt entry, or cache outage must lead to a fresh build.
  rmSync(join(cwd, dist), { recursive: true, force: true });
  rmSync(join(cwd, receipt), { force: true });
  return state;
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export function cacheSummary(env) {
  const state = ['hit', 'miss', 'invalid'].includes(env.CACHE_STATE) ? env.CACHE_STATE : 'unavailable';
  const seconds = /^\d+(?:\.\d+)?$/.test(env.BUILD_SECONDS ?? '') ? env.BUILD_SECONDS : '—';
  const result = ['success', 'failure', 'skipped', 'cancelled'].includes(env.BUILD_OUTCOME) ? env.BUILD_OUTCOME : 'unavailable';
  const restore = ['success', 'failure', 'skipped', 'cancelled'].includes(env.RESTORE_OUTCOME) ? env.RESTORE_OUTCOME : 'unavailable';
  return `\n### PWA build cache\n\n| Cache result | Restore action | Build result | Build seconds |\n| --- | --- | --- | ---: |\n| ${state} | ${restore} | ${result} | ${seconds} |\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cwd = process.cwd();
  const key = process.env.PWA_CACHE_KEY;
  try {
    switch (process.argv[2]) {
      case 'key': output('key', cacheKey(cwd)); break;
      case 'restore': {
        const state = acceptRestore(cwd, key, process.env.PWA_CACHE_HIT);
        output('state', state);
        output('usable', state === 'hit');
        console.log(`PWA cache: ${state}`);
        break;
      }
      case 'build': {
        assert(validKey(key), 'Invalid PWA cache key');
        const start = performance.now();
        try {
          execFileSync('pnpm', ['web:build'], { cwd, stdio: 'inherit' });
          recordBuild(cwd, key);
        } finally { output('seconds', ((performance.now() - start) / 1000).toFixed(1)); }
        break;
      }
      case 'summary': {
        const summary = cacheSummary(process.env);
        if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
        console.log(summary);
        break;
      }
      default: throw new Error('Expected key, restore, build, or summary');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
