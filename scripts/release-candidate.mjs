#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { versionPolicy } from './lib/release-version.mjs';
import { hashFile, inspectPackage } from './lib/package-artifact.mjs';
import { releaseNotes } from './release-tag.mjs';
import { github, githubPages } from './lib/release-github.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
export function inspectSource(cwd, commit) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert(/^[a-f0-9]{40}$/.test(commit ?? ''), 'Expected a full source commit');
  assert(git('rev-parse', 'HEAD') === commit, 'Source checkout differs from requested commit');
  const policy = versionPolicy(JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version);
  git('merge-base', '--is-ancestor', commit, `refs/remotes/origin/${policy.branch}`);
  releaseNotes(cwd, policy.version);
  return { ...policy, commit, tag: `v${policy.version}` };
}

export function prepareCandidate(cwd, directory, commit, runId, repository) {
  const identity = inspectSource(cwd, commit);
  assert(/^[1-9]\d*$/.test(String(runId)), 'Candidate requires its Actions run ID');
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Candidate requires its repository');
  const filename = `palmagent-${identity.version}.tgz`;
  assert(readdirSync(directory).filter((name) => name.endsWith('.tgz')).join() === filename, 'Expected one candidate tarball');
  inspectPackage(join(directory, filename), { ...identity, publishable: true });
  const candidate = { schemaVersion: 1, ...identity, filename, sha256: hashFile(join(directory, filename)),
    runId: String(runId), repository, runUrl: `https://github.com/${repository}/actions/runs/${runId}` };
  writeFileSync(join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  writeFileSync(join(directory, 'SHA256SUMS'), `${candidate.sha256}  ${filename}\n`);
  writeFileSync(join(directory, 'RELEASE_NOTES.md'), releaseNotes(cwd, identity.version));
  return candidate;
}

export function validateCandidate(cwd, directory, { commit, runId, repository, sha256 } = {}) {
  const candidate = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
  const identity = inspectSource(cwd, commit);
  assert(candidate.schemaVersion === 1, 'Unsupported candidate manifest');
  for (const [key, value] of Object.entries(identity)) assert(candidate[key] === value, `Candidate identity mismatch: ${key}`);
  assert(candidate.runId === String(runId) && candidate.repository === repository, 'Candidate producer differs from the selected run');
  assert(candidate.runUrl === `https://github.com/${repository}/actions/runs/${runId}`, 'Candidate run URL mismatch');
  assert(candidate.filename === `palmagent-${identity.version}.tgz`, 'Unexpected candidate filename');
  assert(/^[a-f0-9]{64}$/.test(candidate.sha256) && (!sha256 || candidate.sha256 === sha256), 'Candidate changed after approval preparation');
  const path = join(directory, candidate.filename);
  assert(hashFile(path) === candidate.sha256, 'Candidate checksum mismatch');
  assert(readFileSync(join(directory, 'SHA256SUMS'), 'utf8') === `${candidate.sha256}  ${candidate.filename}\n`, 'Candidate checksum file mismatch');
  assert(readFileSync(join(directory, 'RELEASE_NOTES.md'), 'utf8') === releaseNotes(cwd, candidate.version), 'Candidate release notes mismatch');
  inspectPackage(path, { ...identity, publishable: true });
  return { ...candidate, path, environment: `npm-${identity.channel}` };
}

export function assertCandidateRun(run, repository) {
  assert(run.repository?.full_name === repository, 'Candidate run belongs to another repository');
  assert(['.github/workflows/npm-publish.yml', '.github/workflows/release-candidate.yml'].includes(run.path?.split('@')[0]), 'Untrusted candidate producer workflow');
  assert(run.event === 'workflow_dispatch' && ['main', 'develop'].includes(run.head_branch), 'Untrusted candidate producer ref or event');
  // The whole publication run may be waiting for approval or have failed after upload.
  // A retained immutable artifact is uploaded only after every candidate check succeeds.
  assert(run.id && /^[a-f0-9]{40}$/.test(run.head_sha ?? ''), 'Missing candidate workflow identity');
}

export function candidateArtifact(commit, runId, repository, { reuse = false, api = github, pages = githubPages } = {}) {
  assert(/^[a-f0-9]{40}$/.test(commit ?? '') && /^[1-9]\d*$/.test(String(runId)), 'Invalid candidate artifact identity');
  const run = api(repository, `actions/runs/${runId}`);
  assertCandidateRun(run, repository);
  const name = `palmagent-candidate-${commit}`;
  const matches = pages(repository, `actions/runs/${runId}/artifacts`, 'artifacts').filter((artifact) => artifact.name === name);
  assert(matches.length <= 1 && !matches.some((artifact) => artifact.expired), 'Candidate artifact is ambiguous or expired');
  assert(!reuse || matches.length === 1, 'Requested candidate artifact is unavailable; do not rebuild reviewed bytes');
  return { artifact: name, producer: String(runId), reuse: matches.length === 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, source = '.', directory = 'build/release'] = process.argv.slice(2);
    const env = process.env;
    let result;
    if (command === 'artifact') result = candidateArtifact(env.RELEASE_COMMIT, env.CANDIDATE_RUN_ID || env.GITHUB_RUN_ID, env.GH_REPO, { reuse: Boolean(env.CANDIDATE_RUN_ID) });
    else if (command === 'source') result = inspectSource(resolve(source), env.RELEASE_COMMIT);
    else if (command === 'prepare') result = prepareCandidate(resolve(source), resolve(directory), env.RELEASE_COMMIT, env.GITHUB_RUN_ID, env.GH_REPO);
    else if (command === 'check') result = validateCandidate(resolve(source), resolve(directory), {
      commit: env.RELEASE_COMMIT, runId: env.CANDIDATE_RUN_ID, repository: env.GH_REPO, sha256: env.EXPECTED_ARTIFACT_SHA256,
    });
    else throw new Error('Usage: node scripts/release-candidate.mjs source|prepare|check [source] [directory]');
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(result).filter(([key]) => ['version', 'channel', 'branch', 'commit', 'sha256', 'environment', 'artifact', 'producer', 'reuse'].includes(key)).map(([key, value]) => `${key}=${value}\n`).join(''));
    if (command === 'check' && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY,
      `## Release candidate\n\nPackage: palmagent@${result.version}\n\nChannel: ${result.channel}\n\nSource: ${result.commit}\n\nSHA-256: ${result.sha256}\n\nValidation: ${result.runUrl}\n\n${readFileSync(join(resolve(directory), 'RELEASE_NOTES.md'), 'utf8')}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
