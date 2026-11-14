import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (root, path) => path === root || path.startsWith(root + sep);
const run = (cwd, command, args) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
}).trim();
const git = (cwd, ...args) => run(cwd, 'git', args);

function operationInProgress(cwd) {
  return ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'index.lock']
    .some(name => existsSync(resolve(cwd, git(cwd, 'rev-parse', '--git-path', name))));
}

// Linux inspection is conservative. On other hosts, retain resources for native/manual cleanup.
export function checkoutBusy(root, { primary = false, excluded = [] } = {}) {
  if (process.platform !== 'linux') return 'process inspection unavailable';
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    if (Number(entry) === process.pid) continue;
    try {
      const uses = path => inside(root, path.replace(/ \(deleted\)$/, ''))
        && !excluded.some(excludedPath => inside(excludedPath, path));
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      const command = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0');
      // A passive shell or agent cwd alone does not block primary checkout updates.
      const passive = primary && /(?:^|\/)(?:bash|zsh|sh|fish|codex|claude)$/.test(command[0] ?? '');
      if (uses(cwd) && !passive) return `process ${entry} uses checkout`;
      const referenced = command.some(arg => uses(arg.split('=').at(-1)))
        || uses(readlinkSync(`/proc/${entry}/exe`))
        || readdirSync(`/proc/${entry}/fd`).some(fd => {
          try { return uses(readlinkSync(`/proc/${entry}/fd/${fd}`)); }
          catch (error) { if (error.code === 'ENOENT') return false; throw error; }
        });
      if (referenced) return `process ${entry} uses checkout`;
    } catch (error) {
      // Protected system processes are not observable; the caller must release task sessions
      // before applying cleanup. Never infer that an inaccessible process belongs to this task.
      if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
  }
  return undefined;
}

export function finishTask({ cwd, worktree, pr, apply = false, busy = checkoutBusy }) {
  const reports = [];
  const primary = realpathSync(git(cwd, 'worktree', 'list', '--porcelain').split('\n')[0].slice(9));
  const target = realpathSync(worktree);
  const registry = git(primary, 'worktree', 'list', '--porcelain').split('\n\n').map(block => {
    const lines = block.split('\n');
    return { path: lines.find(line => line.startsWith('worktree '))?.slice(9),
      branch: lines.find(line => line.startsWith('branch '))?.slice(7) };
  });
  const entry = registry.find(item => item.path === target);
  if (target === primary || !entry || !inside(join(primary, '.harness/worktrees'), target)
      || !entry.branch?.startsWith('refs/heads/feature/')) {
    throw new Error('Expected a registered manual feature worktree under .harness/worktrees.');
  }
  if (inside(target, realpathSync(cwd))) throw new Error('Run cleanup from outside the task worktree.');
  const branch = entry.branch.slice('refs/heads/'.length);
  if (pr.state !== 'MERGED' || pr.baseRefName !== 'develop' || pr.isCrossRepository
      || pr.headRefName !== branch || !/^[a-f0-9]{40}$/.test(pr.headRefOid ?? '')
      || !/^[a-f0-9]{40}$/.test(pr.mergeCommit?.oid ?? '')) {
    throw new Error('PR must be merged into develop from this repository and task branch.');
  }
  git(primary, 'fetch', '--no-tags', 'origin', 'refs/heads/develop:refs/remotes/origin/develop');
  git(primary, 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'origin/develop');

  const primaryBlock = () => {
    if (git(primary, 'branch', '--show-current') !== 'develop') return 'primary is not on develop';
    if (git(primary, 'status', '--porcelain', '--untracked-files=normal')) return 'primary has uncommitted files';
    if (operationInProgress(primary)) return 'primary has a Git operation in progress';
    const active = busy(primary, { primary: true, excluded: registry.filter(item => item.path !== primary).map(item => item.path) });
    if (active) return active;
    try { git(primary, 'merge-base', '--is-ancestor', 'HEAD', 'origin/develop'); }
    catch { return 'local develop has diverged'; }
  };
  const blocked = primaryBlock();
  if (blocked) reports.push(`RETAIN develop: ${blocked}`);
  else if (apply) {
    git(primary, 'merge', '--ff-only', 'origin/develop');
    if (git(primary, 'rev-parse', 'HEAD') !== git(primary, 'rev-parse', 'origin/develop')) throw new Error('Develop verification failed');
    reports.push(`UPDATED develop: ${git(primary, 'rev-parse', 'HEAD')}`);
  } else reports.push('READY develop: fast-forward');

  const taskBlock = () => {
    if (git(target, 'symbolic-ref', 'HEAD') !== entry.branch || git(target, 'rev-parse', 'HEAD') !== pr.headRefOid) return 'task no longer matches merged PR head';
    if (operationInProgress(target)) return 'task has a Git operation in progress';
    if (git(target, 'status', '--porcelain', '--untracked-files=normal', '--ignored=matching')) return 'task contains changed, untracked, or ignored files';
    return busy(target);
  };
  const retained = taskBlock();
  const label = relative(primary, target);
  if (retained) reports.push(`RETAIN ${label}: ${retained}`);
  else if (!apply) reports.push(`READY ${label}: remove worktree and attempt non-force branch deletion`);
  else {
    git(primary, 'worktree', 'remove', target);
    if (existsSync(target) || git(primary, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${target}`)) throw new Error('Worktree removal verification failed');
    reports.push(`REMOVED ${label}`);
    // git branch -d can consult an upstream instead of HEAD. Guard the intended merged base too.
    try {
      git(primary, 'merge-base', '--is-ancestor', pr.headRefOid, 'origin/develop');
      git(primary, 'branch', '-d', branch);
      reports.push(`REMOVED branch ${branch}`);
    } catch { reports.push(`RETAIN branch ${branch}: non-force deletion requires merged ancestry`); }
  }
  return reports;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let number, worktree, apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pr' && /^\d+$/.test(args[i + 1] ?? '')) number = args[++i];
    else if (args[i] === '--worktree' && isAbsolute(args[i + 1] ?? '')) worktree = args[++i];
    else if (args[i] === '--apply') apply = true;
    else { console.error('Usage: node scripts/finish-task.mjs --pr number --worktree absolute-path [--apply]'); process.exit(2); }
  }
  if (!number || !worktree) { console.error('--pr and --worktree are required'); process.exit(2); }
  try {
    const cwd = process.cwd();
    const pr = JSON.parse(run(cwd, 'gh', ['pr', 'view', number, '--json', 'state,baseRefName,headRefName,headRefOid,mergeCommit,isCrossRepository']));
    for (const report of finishTask({ cwd, worktree, pr, apply })) console.log(report);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
