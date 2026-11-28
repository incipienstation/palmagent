// Read immutable Git objects so a later edit, deletion or merge cannot hide a match.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { leakLines } from './lib/source-leaks.mjs';

const [base, head] = process.argv.slice(2);
const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
});
try {
  if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ''))) throw Error();
  git('merge-base', base, head);
  const commits = git('rev-list', `${base}..${head}`).trim().split('\n').filter(Boolean);
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    const boundary = new Set(readFileSync(git('rev-parse', '--git-path', 'shallow').trim(), 'utf8').trim().split('\n'));
    if (commits.some(commit => boundary.has(commit))) throw Error();
  }
  const seen = new Set();
  for (const commit of commits) {
    const report = (location, lines) => {
      if (!lines.length) return;
      process.exitCode = 1;
      console.error(`${commit.slice(0, 12)} ${location}:${lines[0]} (possible private content)`);
    };
    report('commit message', leakLines(git('show', '-s', '--format=%B', commit)));
    // Each side parent is also visited by rev-list. Compare merge results to their first parent.
    const changes = git('diff-tree', '--root', '--diff-merges=first-parent', '--no-commit-id',
      '--no-renames', '--diff-filter=AMT', '--raw', '--no-abbrev', '-r', '-z', commit).split('\0');
    for (let i = 0; i < changes.length - 1; i += 2) {
      const [, mode, , blob] = changes[i].split(' ');
      const path = changes[i + 1];
      const sensitiveName = leakLines(path);
      report('filename', sensitiveName);
      const key = JSON.stringify([path, blob]);
      if (seen.has(key) || mode === '160000') continue;
      seen.add(key);
      const text = git('cat-file', 'blob', blob);
      report(sensitiveName.length ? 'file' : JSON.stringify(path), leakLines(text, path));
    }
  }
  if (!process.exitCode) console.log(`Checked ${commits.length} outgoing commit(s) through ${head}.`);
} catch {
  console.error('Cannot scan the complete outgoing history. Fetch full history and use the remote base or its known full SHA.');
  process.exitCode = 1;
}
