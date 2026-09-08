import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (cwd, ...args) => execFileSync('git', args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const isCommit = (value) => /^[a-f0-9]{40}$/.test(value ?? '');

export function checkSource(cwd, commit) {
  assert(isCommit(commit), 'Provide a full 40-character staging commit SHA');
  assert.equal(git(cwd, 'cat-file', '-t', commit), 'commit', 'Staging source must be a commit object');
  git(cwd, 'merge-base', '--is-ancestor', commit, 'refs/remotes/origin/develop');
  return commit;
}

export function recordPackage(cwd, commit, workflowCommit, runUrl) {
  assert(isCommit(commit) && isCommit(workflowCommit), 'Source and workflow commit SHAs are required');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), commit, 'Candidate checkout does not match the selected commit');
  const version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const directory = join(cwd, 'build/staging');
  const filename = `palmagent-${version}.tgz`;
  assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.tgz')), [filename],
    'Expected exactly one versioned staging tarball');
  const sha256 = createHash('sha256').update(readFileSync(join(directory, filename))).digest('hex');
  const record = { commit, workflowCommit, version, filename, sha256, runUrl };
  writeFileSync(join(directory, 'staging.json'), JSON.stringify(record, null, 2) + '\n');
  writeFileSync(join(directory, 'SHA256SUMS'), `${sha256}  ${filename}\n`);
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { STAGING_COMMIT, GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    if (process.argv[2] === 'check') {
      const commit = checkSource(process.cwd(), STAGING_COMMIT);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\n`);
      console.log(`Staging source verified: ${commit}`);
    } else if (process.argv[2] === 'record' && process.argv[3]) {
      recordPackage(resolve(process.argv[3]), STAGING_COMMIT, GITHUB_SHA,
        `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`);
    } else throw new Error('Usage: node scripts/staging-candidate.mjs check|record <candidate-directory>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
