#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { hashFile, inspectPackage } from './lib/package-artifact.mjs';
import { versionPolicy } from './lib/release-version.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const save = (path, value) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
};

export function validateBinding(config, call = run) {
  assert(config.environment === 'staging', 'An explicit staging binding is required');
  for (const key of ['dataDir', 'npmPrefix', 'pkgDir']) assert(isAbsolute(config[key] ?? ''), `Binding requires absolute ${key}`);
  const installed = Object.fromEntries(readFileSync(join(config.dataDir, 'install.env'), 'utf8').split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
  assert(installed.MODE === 'package', 'Staging deployment requires an existing package installation');
  assert(installed.RUN_USER === userInfo().username, 'Run deployment as the installed service owner');
  assert(installed.DOMAIN === config.domain && /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(config.domain), 'Installed domain differs from staging binding');
  assert(realpathSync(installed.PKG_DIR) === realpathSync(config.pkgDir), 'Installed package directory differs from binding');
  assert(!lstatSync(config.pkgDir).isSymbolicLink(), 'Linked development packages cannot be staging targets');
  assert(!installed.DATA_DIR || realpathSync(installed.DATA_DIR) === realpathSync(config.dataDir), 'Installed data directory differs from binding');
  const npmRoot = call('npm', ['root', '--global', '--prefix', config.npmPrefix]).trim();
  assert(realpathSync(join(npmRoot, 'palmagent')) === realpathSync(config.pkgDir), 'npm prefix targets a different installation');
  const host = installed.HOST ?? 'localhost';
  assert(host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host), 'Health target must be loopback');
  const port = Number(installed.PORT ?? 4100);
  assert(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid health port');
  return { ...config, localOrigin: `http://${host === '::1' ? '[::1]' : host}:${port}` };
}

export function verifyInstalled(config, identity) {
  for (const [name, hash] of Object.entries(identity.files)) {
    assert(!name.split('/').includes('..') && !isAbsolute(name), 'Invalid receipt path');
    assert(hashFile(join(config.pkgDir, name)) === hash, `Installed package differs: ${name}`);
  }
}

export async function verifyHealth(config, identity, request = fetch) {
  for (const origin of [config.localOrigin, `https://${config.domain}`]) {
    const response = await request(`${origin}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error' });
    assert(response.ok, 'Staging health HTTP failure');
    const body = await response.json();
    assert(body.ok === true, 'Staging health response failed');
    if (identity.sourceCommit) assert(body.build?.sourceCommit === identity.sourceCommit && body.build?.version === identity.version && body.build?.dirty === false, 'Running build differs from requested package');
    const shell = await request(`${origin}/`, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error' });
    const html = await shell.text();
    assert(shell.ok && createHash('sha256').update(html).digest('hex') === identity.files['web/index.html'], 'Served PWA shell differs from package');
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="(\/assets\/[\w.-]+\.js)"/g)].map((match) => match[1]);
    assert(scripts.length > 0, 'PWA has no entry script');
    for (const path of scripts) {
      const asset = await request(origin + path, { cache: 'no-store', signal: AbortSignal.timeout(10000), redirect: 'error' });
      assert(asset.ok && createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex') === identity.files[`web${path}`], 'Served PWA script differs from package');
    }
  }
}

function pack(spec, directory, call) {
  const result = JSON.parse(call('npm', ['pack', spec, '--json', '--ignore-scripts', '--registry=https://registry.npmjs.org', '--pack-destination', directory]));
  assert(result.length === 1 && /^[\w.-]+\.tgz$/.test(result[0].filename), 'Expected one npm package');
  return join(directory, result[0].filename);
}

export function validateTarget(target) {
  assert(/^[a-f0-9]{40}$/.test(target.commit ?? ''), 'An exact source commit is required');
  assert(Boolean(target.version) !== Boolean(target.artifact), 'Choose an exact npm version or a CI artifact');
  if (target.version) versionPolicy(target.version);
  else assert(/^[a-f0-9]{64}$/.test(target.sha256 ?? ''), 'CI artifact requires its reviewed SHA-256');
}

// Dependencies are injected only by tests. All production mutations use the
// installed CLI, which owns systemd/nginx and runner restart decisions.
export async function deploy(config, target, { call = run, health = verifyHealth, installed = verifyInstalled, bind = validateBinding } = {}) {
  validateTarget(target);
  config = bind(config, call);
  const scratch = mkdtempSync(join(tmpdir(), 'palmagent-staging-'));
  let lock;
  let receipt;
  let receiptPath;
  try {
    const artifact = join(scratch, 'target.tgz');
    copyFileSync(target.artifact ? resolve(target.artifact) : pack(`palmagent@${target.version}`, scratch, call), artifact);
    if (target.sha256) assert(hashFile(artifact) === target.sha256, 'Artifact checksum mismatch');
    const identity = inspectPackage(artifact, { version: target.version, commit: target.commit });
    if (target.dryRun) return { status: 'validated', environment: 'staging', target: identity };
    const directory = join(config.dataDir, 'deployments');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, '.lock');
    mkdirSync(lockPath, { mode: 0o700 }); // Existing/stale locks fail closed.
    lock = lockPath;
    save(join(lock, 'owner.json'), { pid: process.pid, started: new Date().toISOString() });
    config = bind(config, call); // Check again under the deployment lock.
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const deployment = join(directory, id);
    mkdirSync(deployment, { mode: 0o700 });
    const previousPath = pack(config.pkgDir, deployment, call);
    const previous = inspectPackage(previousPath, { allowLegacy: true });
    installed(config, previous); // Snapshot must include the installed product bytes.
    const targetPath = join(deployment, 'target.tgz');
    copyFileSync(artifact, targetPath);
    receiptPath = join(deployment, 'deployment.json');
    receipt = { environment: 'staging', config, created: new Date().toISOString(), status: 'prepared', target: identity,
      targetPath, previous: { ...previous, path: previousPath }, database: 'untouched by deploy script; activation may migrate schema' };
    save(receiptPath, receipt);
    receipt.status = 'installing'; save(receiptPath, receipt);
    call('npm', ['install', '--global', '--prefix', config.npmPrefix, targetPath, '--registry=https://registry.npmjs.org']);
    installed(config, identity);
    receipt.status = 'activating'; save(receiptPath, receipt);
    call(process.execPath, [join(config.pkgDir, 'cli.js'), 'update', '--data-dir', config.dataDir, '--non-interactive']);
    installed(config, identity);
    await health(config, identity);
    receipt.status = 'succeeded'; receipt.completed = new Date().toISOString(); save(receiptPath, receipt);
    save(join(directory, 'current.json'), { receipt: receiptPath });
    return { status: receipt.status, receipt: receiptPath, version: identity.version, commit: identity.sourceCommit, sha256: identity.sha256 };
  } catch (error) {
    if (receipt) {
      receipt.failedAt = receipt.status; receipt.status = 'failed'; save(receiptPath, receipt);
      throw new Error(`Deployment failed at ${receipt.failedAt}; inspect receipt ${receiptPath}. No database or automatic rollback was performed.`, { cause: error });
    }
    throw error;
  } finally {
    if (lock) rmSync(lock, { recursive: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function rollback(config, path, databaseCompatible, { call = run, health = verifyHealth, installed = verifyInstalled, bind = validateBinding } = {}) {
  assert(databaseCompatible, 'Rollback requires explicit --database-compatible after reviewing schema compatibility');
  config = bind(config, call);
  const receipt = json(path);
  assert(receipt.environment === 'staging' && ['succeeded', 'failed'].includes(receipt.status), 'Receipt is not a rollback candidate');
  for (const key of ['domain', 'pkgDir', 'dataDir', 'npmPrefix']) assert(receipt.config[key] === config[key], 'Rollback receipt belongs to another installation');
  const previous = inspectPackage(receipt.previous.path, { allowLegacy: true });
  assert(previous.sha256 === receipt.previous.sha256, 'Rollback artifact checksum mismatch');
  const directory = join(config.dataDir, 'deployments');
  const lock = join(directory, '.lock');
  mkdirSync(lock, { mode: 0o700 });
  try {
    save(join(lock, 'owner.json'), { pid: process.pid, started: new Date().toISOString(), operation: 'rollback' });
    // Never roll back over a later deployment or an unrecorded manual overlay.
    installed(config, receipt.target);
    receipt.rollback = { status: 'installing', started: new Date().toISOString() }; save(path, receipt);
    call('npm', ['install', '--global', '--prefix', config.npmPrefix, receipt.previous.path, '--registry=https://registry.npmjs.org']);
    installed(config, previous);
    receipt.rollback.status = 'activating'; save(path, receipt);
    call(process.execPath, [join(config.pkgDir, 'cli.js'), 'update', '--data-dir', config.dataDir, '--non-interactive']);
    installed(config, previous);
    await health(config, previous);
    receipt.rollback.status = 'succeeded'; receipt.rollback.completed = new Date().toISOString(); save(path, receipt);
    save(join(directory, 'current.json'), { receipt: resolve(path), rollback: true });
    return { status: 'rolled-back', receipt: resolve(path), version: previous.version, sha256: previous.sha256 };
  } catch (error) {
    if (receipt.rollback) { receipt.rollback.failedAt = receipt.rollback.status; receipt.rollback.status = 'failed'; save(path, receipt); }
    throw error;
  } finally { rmSync(lock, { recursive: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      config: { type: 'string' }, 'data-dir': { type: 'string' }, 'npm-prefix': { type: 'string' }, domain: { type: 'string' },
      version: { type: 'string' }, artifact: { type: 'string' }, sha256: { type: 'string' }, commit: { type: 'string' },
      receipt: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'database-compatible': { type: 'boolean' },
    } });
    const path = resolve(values.config ?? join(homedir(), '.config', 'palmagent', 'staging.json'));
    const command = positionals[0];
    if (command === 'bind') {
      assert(values['data-dir'] && values['npm-prefix'] && values.domain, 'bind requires --data-dir, --npm-prefix, and --domain');
      assert(!existsSync(path), 'Binding already exists; review it before editing');
      const config = validateBinding({ environment: 'staging', dataDir: resolve(values['data-dir']), npmPrefix: resolve(values['npm-prefix']),
        pkgDir: join(run('npm', ['root', '--global', '--prefix', resolve(values['npm-prefix'])]).trim(), 'palmagent'), domain: values.domain });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); save(path, config);
      console.log(`Staging binding saved: ${path}`);
    } else if (command === 'deploy') {
      console.log(JSON.stringify(await deploy(json(path), { ...values, dryRun: values['dry-run'] }), null, 2));
    } else if (command === 'rollback') {
      assert(values.receipt, 'rollback requires --receipt');
      console.log(JSON.stringify(await rollback(json(path), resolve(values.receipt), values['database-compatible']), null, 2));
    } else throw new Error('Usage: pnpm staging:deploy bind|deploy|rollback (see docs/STAGING.md)');
  } catch (error) { console.error(error.message); if (error.cause) console.error(error.cause.message); process.exitCode = 1; }
}
