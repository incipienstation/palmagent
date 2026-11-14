import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Hash source bytes, Git state, environment values (never stored), and installed dependency
// metadata. This is explicit retry evidence, not a cache for external services or release acceptance.
export function verificationFingerprint(cwd, context, steps, env) {
  const hash = createHash('sha256'), inputs = {};
  const mark = name => { inputs[name] = hash.copy().digest('hex'); };
  const add = value => hash.update(JSON.stringify(value) + '\n');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  add([realpathSync(cwd), context, steps, process.version, process.platform, process.arch]);
  mark('plan');
  // Invocation IDs and shell bookkeeping change between tool calls, not check behavior.
  const transient = new Set(['CODEX_TOOL_CALL_ID', '_', 'SHLVL']);
  add(Object.entries(env).filter(([key]) => !transient.has(key)).sort(([a], [b]) => a.localeCompare(b)));
  mark('environment');
  add(git('rev-parse', 'HEAD'));
  add(git('ls-files', '--stage', '-z'));
  mark('Git state');
  const paths = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))].sort();
  const roots = new Set([cwd]);
  const linkedSources = [];
  for (const path of paths) {
    add(path);
    const full = join(cwd, path);
    try {
      const stat = lstatSync(full);
      add([stat.mode, stat.size]);
      if (stat.isSymbolicLink()) { add(readlinkSync(full)); linkedSources.push(realpathSync(full)); }
      else if (stat.isFile()) hash.update(readFileSync(full));
      else throw new Error('Unsupported verification source entry');
    } catch (error) { if (error.code === 'ENOENT') add('missing'); else throw error; }
    if (path.endsWith('package.json')) roots.add(dirname(full));
  }
  mark('source');
  const visited = new Set();
  function metadata(path) {
    let stat;
    try { stat = lstatSync(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') { add([path, 'missing']); return; } throw error; }
    add([path, String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
    if (stat.isSymbolicLink()) {
      add(readlinkSync(path));
      const target = realpathSync(path);
      metadata(target);
    } else if (stat.isDirectory()) {
      if (visited.has(path)) return;
      visited.add(path);
      for (const child of readdirSync(path).sort()) metadata(join(path, child));
    }
  }
  for (const target of linkedSources.sort()) metadata(target);
  metadata(process.execPath);
  for (const root of [...roots].sort()) {
    metadata(join(root, 'node_modules'));
    for (const name of readdirSync(root).filter(name => name === '.env' || name.startsWith('.env.')).sort()) {
      metadata(join(root, name));
    }
  }
  mark('installed or linked files');
  return { fingerprint: hash.digest('hex'), inputs };
}

export function readEvidence(directory) {
  try {
    const value = JSON.parse(readFileSync(join(resolve(directory), 'evidence.json'), 'utf8'));
    if (value.version === 1 && typeof value.fingerprint === 'string' && Array.isArray(value.passed)) return value;
  } catch { /* Missing or invalid evidence means a fresh run. */ }
  return undefined;
}

export function writeEvidence(directory, fingerprint, passed) {
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ version: 1, ...fingerprint, passed }) + '\n', { mode: 0o600 });
}
