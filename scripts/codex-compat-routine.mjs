#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareProtocolContracts, readProtocolContract } from './lib/codex-schema-contract.mjs';
import { allowedChanges, gateVersion, lastSupported, nextCandidate, saveState, updateCompatibility } from './lib/codex-compatibility.mjs';

const script = fileURLToPath(import.meta.url);
const cwd = process.cwd();
const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const allowRepair = args.has('--allow-codex-repair');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const git = (directory, ...argv) => execFileSync('git', argv, { cwd: directory, encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const privateDir = path => { mkdirSync(path, { recursive: true, mode: 0o700 }); return path; };
const hash = value => createHash('sha256').update(value).digest('hex');
const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const stateRoot = privateDir(join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'),
  'palmagent', 'codex-compatibility', hash(common).slice(0, 16)));
const logs = privateDir(join(stateRoot, 'logs'));
let sequence = 0;

class CommandFailure extends Error {
  constructor(label, log, code, output = '') {
    super(label + ' failed (' + code + '); private log: ' + log);
    this.code = code; this.output = output;
  }
}
const infrastructureFailure = error => error instanceof CommandFailure
  && (typeof error.code !== 'number' || [126, 127].includes(error.code));
// A lifetime pipe makes command groups die even when the routine controller is
// killed by a service restart. Each command timeout also kills its descendants.
const commandSupervisor = String.raw`
const { spawn } = require('node:child_process');
let buffer = '', started = false;
process.stdin.on('end', () => process.kill(-process.pid, 'SIGKILL'));
process.stdin.on('data', chunk => {
  if (started) return;
  buffer += chunk;
  if (!buffer.includes('\n')) return;
  started = true;
  const spec = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
  const child = spawn(spec.command, spec.argv, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(spec.input);
  child.on('error', () => process.exit(127));
  child.on('exit', (code) => process.exit(code ?? 1));
});
`;
function run(command, argv, { directory = cwd, env = process.env, input, timeout = 600_000, label = command, captureStderr = false } = {}) {
  const log = join(logs, Date.now() + '-' + process.pid + '-' + (++sequence) + '.log');
  writeFileSync(log, '', { mode: 0o600 });
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['--input-type=commonjs', '-e', commandSupervisor],
      { cwd: directory, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } };
    let output = '', bytes = 0, expired = false;
    const timer = setTimeout(() => { expired = true; kill(); }, timeout);
    const collect = chunk => {
      bytes += chunk.length;
      if (bytes <= 32 * 1024 * 1024) { appendFileSync(log, chunk); output += chunk.toString(); }
      else { expired = true; kill(); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', chunk => {
      if (captureStderr) collect(chunk);
      else {
        bytes += chunk.length;
        if (bytes <= 32 * 1024 * 1024) appendFileSync(log, chunk);
        else { expired = true; kill(); }
      }
    });
    child.on('error', () => { clearTimeout(timer); fail(new CommandFailure(label, log, 'launch')); });
    child.on('exit', kill);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || expired) fail(new CommandFailure(label, log, expired ? 'timeout/output-limit' : code, output));
      else ok(output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ command, argv, input }) + '\n');
  });
}
function providerEnvironment(home, bin) {
  const env = { ...process.env, CODEX_HOME: home,
    PATH: bin ? bin + ':' + dirname(process.execPath) + ':' + process.env.PATH : process.env.PATH, NX_DAEMON: 'false' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) delete env[key];
  return env;
}
async function installCli(version) {
  const prefix = privateDir(join(stateRoot, 'cli', version));
  const bin = join(prefix, 'node_modules/.bin');
  const executable = join(bin, 'codex');
  if (!existsSync(executable)) {
    await run('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--ignore-scripts',
      '--package-lock=false', '--save-exact', '@openai/codex@' + version], { label: 'Install Codex ' + version, timeout: 300_000 });
  }
  const actual = await run(executable, ['--version'], { label: 'Check installed CLI', timeout: 30_000 });
  assert(actual === 'codex-cli ' + version, 'Downloaded CLI version differs from the exact target');
  return { version, executable, bin };
}
async function handshake(cli, env, directory) {
  return new Promise((ok, fail) => {
    // initialize does not create a thread or inference turn.
    const child = spawn(cli.executable, ['app-server', '--listen', 'stdio://'], { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', initialized = false, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); child.kill('SIGKILL');
      error ? fail(error) : ok();
    };
    const timer = setTimeout(() => finish(new Error('App Server initialize timed out')), 30_000);
    child.stderr.resume();
    child.on('error', () => finish(new Error('App Server failed to start')));
    child.on('close', () => { if (!initialized) finish(new Error('App Server exited before initialize')); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error('App Server initialize output exceeded limit'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 'compatibility') continue;
        if (message.error || !message.result) return finish(new Error('App Server rejected initialize'));
        initialized = true; finish();
      }
    });
    child.stdin.write(JSON.stringify({ id: 'compatibility', method: 'initialize',
      params: { clientInfo: { name: 'palmagent', version: '1.0.0' }, capabilities: {} } }) + '\n');
  });
}
async function inspectCli(cli, work, freshContract = false) {
  const home = privateDir(mkdtempSync(join(stateRoot, 'offline-')));
  const env = providerEnvironment(home, cli.bin);
  const schemas = privateDir(join(home, 'schema'));
  await run(cli.executable, ['app-server', 'generate-json-schema', '--out', schemas], { env, directory: home, timeout: 60_000 });
  const contracts = freshContract ? JSON.parse(await run(process.execPath, ['--input-type=module', '-e',
    'import { readProtocolContract } from "./scripts/lib/codex-schema-contract.mjs"; process.stdout.write(JSON.stringify(readProtocolContract(process.argv[1])));',
    schemas], { directory: work, env, label: 'Read repaired protocol specification', timeout: 30_000 })) : readProtocolContract(schemas);
  for (const [argv, flags] of [
    [['exec', '--help'], ['--json', '--sandbox', '--image', '--config', '--skip-git-repo-check']],
    [['exec', 'resume', '--help'], ['--json', '--image', '--config', '--skip-git-repo-check']],
  ]) {
    const help = await run(cli.executable, argv, { env, directory: home, timeout: 30_000 });
    for (const flag of flags) assert(help.includes(flag), 'CLI removed adapter flag: ' + flag);
  }
  await handshake(cli, env, home);
  await run('pnpm', ['server:contracts'], { directory: work, env, label: 'Hermetic server contracts ' + cli.version });
  return { contracts, schemas, digest: hash(JSON.stringify(contracts)) };
}
function changedPaths(work, base) {
  return git(work, 'diff', '--name-only', '--no-renames', base, '--').split('\n').filter(Boolean)
    .concat(git(work, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean));
}
async function api(path, method = 'GET', body) {
  return JSON.parse(await run('gh', ['api', path, '--method', method, ...(body ? ['--input', '-'] : [])],
    { input: body ? JSON.stringify(body) : undefined, timeout: 60_000, label: 'GitHub ' + method }));
}
async function registry() {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(await run('npm', ['view', '@openai/codex', 'versions', 'dist-tags', '--json'],
        { timeout: 60_000, label: 'Read Codex registry' }));
    } catch (error) { if (attempt === 2) throw error; }
  }
}
async function shipJob(repository, state, save) {
  const work = state.worktree;
  assert(git(work, 'rev-parse', 'HEAD') === state.head && !git(work, 'status', '--porcelain'), 'Owned compatibility branch was modified; holding');
  const stem = 'repos/' + repository;
  const prs = await api(stem + '/pulls?state=all&head=' + repository.split('/')[0] + ':' + state.branch);
  let pr = prs[0];
  if (pr) {
    assert(pr.base.ref === 'develop' && pr.head.repo?.full_name === repository && [state.head, state.previousHead].includes(pr.head.sha)
      && pr.body?.includes(state.marker), 'Compatibility PR identity changed; holding');
    if (pr.merged_at) { state.stage = 'merged'; state.pr = pr.html_url; await save(); return; }
    assert(pr.state === 'open' && !pr.draft, 'Compatibility PR was closed or held; preserving it');
  }
  await run('git', ['fetch', 'origin', 'develop'], { directory: work });
  const base = git(work, 'rev-parse', 'origin/develop');
  if (base !== state.base) {
    // Rebase only the recorded, clean branch. All selected checks must rerun;
    // never reuse live evidence after a source change or spend again implicitly.
    assert(state.mode !== 'repaired-live', 'Base advanced after paid verification; retained PR needs review without another automatic paid attempt');
    try { await run('git', ['rebase', 'origin/develop'], { directory: work }); }
    catch (error) { await run('git', ['rebase', '--abort'], { directory: work }); throw error; }
    const oldHead = state.head;
    state.base = base; state.head = git(work, 'rev-parse', 'HEAD');
    state.previousHead ??= oldHead; state.validated = false; state.needsCompatibilityCheck = true; await save();
  }
  if (state.needsCompatibilityCheck) {
    // A new base can change the adapter itself. Recheck the exact candidate.
    const oldCli = await installCli(state.baseline);
    const newCli = await installCli(state.version);
    await run('pnpm', ['install', '--frozen-lockfile'], { directory: work, label: 'Refresh verification dependencies' });
    const before = await inspectCli(oldCli, work);
    const after = await inspectCli(newCli, work);
    assert(!compareProtocolContracts(before.contracts, after.contracts).length, 'Compatibility changed after rebase; holding without paid escalation');
    const evidencePath = join(work, 'docs/codex-compatibility-runs.json');
    const evidence = readJson(evidencePath);
    const receipt = evidence.findLast(entry => entry.version === state.version);
    assert(receipt, 'Missing compatibility evidence after rebase');
    Object.assign(receipt, { source: state.base, checkedAt: new Date().toISOString(),
      baselineSchemaSha256: before.digest, candidateSchemaSha256: after.digest });
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    await run('git', ['add', '--', 'docs/codex-compatibility-runs.json'], { directory: work });
    await run('git', ['commit', '--amend', '--no-edit'], { directory: work });
    state.head = git(work, 'rev-parse', 'HEAD'); state.needsCompatibilityCheck = false; await save();
  }
  assert(allowedChanges(changedPaths(work, state.base), state.mode === 'repaired-live'), 'Compatibility PR contains unexpected files');
  if (!state.validated) {
    await run(process.execPath, ['scripts/verify-local.mjs', '--base', state.base], { directory: work, timeout: 1_500_000, label: 'Scoped source verification' });
    state.validated = true; await save();
  }
  const push = ['push', 'origin', 'HEAD:refs/heads/' + state.branch];
  if (state.previousHead) push.push('--force-with-lease=refs/heads/' + state.branch + ':' + state.previousHead);
  await run('git', push, { directory: work });
  delete state.previousHead; await save();
  if (!pr) {
    const body = state.marker + '\n\nExtends Codex CLI support through ' + state.version + '.\n\n' +
      (state.mode === 'schema-contract'
        ? 'Validated generated schemas for consumed protocol fields, CLI flags, App Server initialize, and hermetic adapter contracts. No inference or authenticated live matrix was run.'
        : 'A schema/contract failure triggered one bounded Codex repair. Adapter contracts and the authenticated exec/app-server matrix passed after repair.') +
      '\n\nRequired CI and repository review rules must pass on this exact head. Verification records are in docs/codex-compatibility-runs.json.';
    pr = await api(stem + '/pulls', 'POST', { title: 'chore: support Codex CLI ' + state.version, head: state.branch, base: 'develop', body });
  }
  state.pr = pr.html_url; state.stage = 'pr'; await save();
  console.log('Compatibility PR: ' + state.pr);
  // The required aggregate job may not exist until all its dependencies finish.
  // Wait for its registration, not just the first few seconds after PR creation.
  // Never treat an empty required-check list as success.
  let checks;
  const checkDeadline = Date.now() + 20 * 60_000;
  while (Date.now() < checkDeadline) {
    try {
      checks = JSON.parse(await run('gh', ['pr', 'checks', String(pr.number), '--repo', repository, '--required', '--json', 'name,state,bucket'],
        { timeout: 60_000, label: 'Read required checks' }));
    } catch (error) {
      try { checks = JSON.parse(error.output); } catch { checks = null; }
    }
    if (checks?.some(check => check.name === 'validate')) break;
    await new Promise(ok => setTimeout(ok, 30_000));
  }
  assert(checks?.some(check => check.name === 'validate'), 'Required CI is not registered yet; resume this PR on the next run');
  // gh returns a nonzero exit for pending checks, so wait via its standard
  // watch command and verify the resulting list separately.
  await run('gh', ['pr', 'checks', String(pr.number), '--repo', repository, '--required', '--watch', '--fail-fast', '--interval', '30'],
    { timeout: 1_200_000, label: 'Required PR CI' });
  checks = JSON.parse(await run('gh', ['pr', 'checks', String(pr.number), '--repo', repository, '--required', '--json', 'name,state,bucket']));
  assert(checks.some(check => check.name === 'validate') && checks.every(check => check.bucket === 'pass'), 'Required CI did not pass');
  const current = await api(stem + '/pulls/' + pr.number);
  const remoteBase = (await api(stem + '/git/ref/heads/develop')).object.sha;
  assert(current.head.sha === state.head && current.base.ref === 'develop' && remoteBase === state.base && !current.draft,
    'PR head/base changed after verification; retry next scheduled run');
  await run('gh', ['pr', 'merge', String(pr.number), '--repo', repository, '--squash', '--match-head-commit', state.head],
    { timeout: 60_000, label: 'Merge verified compatibility PR' });
  const merged = await api(stem + '/pulls/' + pr.number);
  assert(merged.merged && merged.head.sha === state.head, 'Compatibility merge was not confirmed');
  state.stage = 'merged'; state.mergeCommit = merged.merge_commit_sha; await save();
  console.log('Merged Codex support through ' + state.version);
}

async function main() {
  assert([...args].every(arg => ['--apply', '--check-only', '--allow-codex-repair', '--locked'].includes(arg)), 'Unknown routine argument');
  assert(args.has('--check-only') !== apply, 'Choose --check-only or --apply');
  assert(!allowRepair || apply, 'Paid repair requires --apply');
  assert(process.version.slice(1) === readFileSync(join(cwd, '.nvmrc'), 'utf8').trim(), 'Use the repository .nvmrc Node version');
  await run('git', ['fetch', 'origin', 'develop']);
  const source = git(cwd, 'rev-parse', 'origin/develop');
  const metadata = JSON.parse(git(cwd, 'show', source + ':packages/shared/src/agent-compatibility.json'));
  const baseline = lastSupported(metadata.codex);
  const version = nextCandidate(await registry(), baseline);
  if (!version) { console.log('No new stable Codex release. No model calls.'); return; }
  console.log('Checking Codex ' + baseline + ' -> ' + version + ' without inference.');
  const stateFile = join(stateRoot, version + '.json');
  let state = existsSync(stateFile) && apply ? readJson(stateFile) : {
    version, baseline, base: source, branch: 'feature/codex-support-' + version, stage: 'new', repairAttempts: 0,
    marker: '<!-- palmagent-codex-compatibility:' + version + ' -->',
  };
  assert(state.version === version && state.baseline === baseline, 'Stored compatibility job differs from the current support baseline');
  const save = () => { if (apply) saveState(stateFile, state); };
  const repository = JSON.parse(await run('gh', ['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository identity');
  if (['committed', 'pr'].includes(state.stage)) { await shipJob(repository, state, save); return; }
  if (state.stage === 'merged') { console.log('This version was already merged. No model calls.'); return; }
  if (state.repairAttempts || state.stage === 'held') {
    console.log('Version retained for review; no further paid attempts. ' + (state.pr || state.stage));
    process.exitCode = 1; return;
  }
  let work = cwd;
  if (apply) {
    if (state.stage === 'new') {
      const existing = await api('repos/' + repository + '/pulls?state=all&head=' + repository.split('/')[0] + ':' + state.branch);
      assert(!existing.length, 'A compatibility PR already exists without matching local state; holding');
      state.worktree = join(stateRoot, 'work-' + version);
      assert(!existsSync(state.worktree), 'Existing compatibility worktree requires inspection');
      await run('git', ['worktree', 'add', state.worktree, '-b', state.branch, source]);
      state.stage = 'checking'; save();
    }
    work = state.worktree;
    assert(git(work, 'rev-parse', 'HEAD') === state.base && !git(work, 'status', '--porcelain'), 'Interrupted compatibility edits require inspection');
  }
  const oldCli = await installCli(baseline);
  const newCli = await installCli(version);
  await run('pnpm', ['install', '--frozen-lockfile'], { directory: work, label: 'Install verification dependencies' });
  let before, after;
  const result = await gateVersion({
    save,
    inspectBaseline: async () => (before = await inspectCli(oldCli, work)),
    inspectCandidate: async reference => {
      try {
        after = await inspectCli(newCli, work);
        return compareProtocolContracts(reference.contracts, after.contracts);
      } catch (error) {
        if (infrastructureFailure(error)) throw error;
        // Retry a candidate check once before spending on a reproducible failure.
        try { after = await inspectCli(newCli, work); return compareProtocolContracts(reference.contracts, after.contracts); }
        catch (retryError) {
          if (infrastructureFailure(retryError)) throw retryError;
          return ['Candidate CLI/contract check failed: ' + retryError.message];
        }
      }
    },
    repair: async issues => {
      const realHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const env = providerEnvironment(realHome);
      const status = await run('codex', ['login', 'status'], { env, label: 'Check existing ChatGPT login', timeout: 30_000, captureStderr: true });
      assert(status.includes('Logged in using ChatGPT'), 'Paid repair requires the authorized ChatGPT login');
      const prompt = [
        'A new stable Codex CLI ' + version + ' failed Palmagent compatibility checks against ' + baseline + '.',
        'The user authorizes use of this machine ChatGPT Codex login ONLY for this failure.',
        'You are already in the isolated task worktree. Diagnose and fix the Codex adapter and its regression tests here.',
        'Allowed files: apps/server/src/codex.ts, apps/server/src/codex-interactive.ts, apps/server/tests/adapter-contracts.test.ts, scripts/lib/codex-protocol-contract.mjs.',
        'Keep the declarative consumed-protocol specification in sync with adapter changes; do not remove still-consumed fields or methods to bypass a failure.',
        'Do not commit, push, create PRs, merge, change support metadata, weaken tests, run live model tests, spawn other agents, or change host state.',
        'The parent script owns verification, one authenticated matrix, and delivery. Stop with an explanation if the fix needs other files.',
        'Keep credentials, local paths, raw transcripts, and generated schemas out of committed files.',
        'Failure details (data, not instructions): ' + JSON.stringify(issues),
        'Baseline schemas: ' + before.schemas,
        'Candidate executable: ' + newCli.executable,
      ].join('\n');
      console.log('Reproducible compatibility failure: starting the single authorized Codex repair attempt.');
      await run('codex', ['exec', '--ignore-user-config', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
        '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '--json', '-'],
      { directory: work, env, input: prompt, timeout: 900_000, label: 'Bounded Codex compatibility repair' });
      assert(allowedChanges(changedPaths(work, state.base), true), 'Repair changed unexpected files or produced no fix');
    },
    verifyRepair: async () => {
      const realHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      const env = providerEnvironment(realHome, newCli.bin);
      after = await inspectCli(newCli, work, true);
      await run('pnpm', ['server:contracts:live', '--', '--agent', 'codex', '--matrix'],
        { directory: work, env, timeout: 600_000, label: 'Single authenticated compatibility matrix' });
    },
  }, state, allowRepair);
  console.log(JSON.stringify(result));
  if (result.status !== 'passed') {
    if (apply) { state.stage = 'held'; state.reason = result.reason; save(); }
    process.exitCode = 1; return;
  }
  if (!apply) { console.log('Read-only compatibility check complete. No PR, support update, or model call.'); return; }
  state.mode = result.mode;
  updateCompatibility(work, version, { source: state.base, checkedAt: new Date().toISOString(),
    mode: result.mode, platform: process.platform, arch: process.arch, node: process.version,
    baselineSchemaSha256: before.digest, candidateSchemaSha256: after?.digest ?? null });
  await run(process.execPath, ['scripts/sync-skills.mjs'], { directory: work });
  assert(allowedChanges(changedPaths(work, state.base), result.mode === 'repaired-live'), 'Unexpected update files; holding');
  await run('git', ['add', '--', ...changedPaths(work, state.base)], { directory: work });
  await run('git', ['commit', '-m', 'chore: support Codex CLI ' + version], { directory: work });
  state.head = git(work, 'rev-parse', 'HEAD'); state.stage = 'committed'; save();
  await shipJob(repository, state, save);
}

if (!args.has('--locked')) {
  // flock ownership is tied to the process lifetime; shutdown cannot leave a
  // stale lock directory. The routine watchdog owns the entire process group.
  const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '75', join(stateRoot, 'run.lock'),
    process.execPath, script, ...args, '--locked'], { cwd, stdio: 'inherit' });
  child.on('error', () => { console.error('Unable to acquire routine lock'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
