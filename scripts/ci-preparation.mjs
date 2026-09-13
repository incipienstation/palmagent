import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { github } from './lib/release-github.mjs';
import { assertPreparation } from './lib/preview-plan.mjs';
import { preparationMarker } from './preview-release.mjs';

export function validatePreparationDispatch(cwd, env, event, { api = github } = {}) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  const { pr: number, head } = event.inputs ?? {};
  assert(/^[1-9][0-9]*$/.test(number ?? ''), 'Invalid preparation PR number');
  assert(/^[a-f0-9]{40}$/.test(head ?? ''), 'Invalid preparation head');
  assert.equal(env.GITHUB_SHA, head, 'Dispatch ref advanced beyond the selected head');
  const pr = api(env.GITHUB_REPOSITORY, `pulls/${number}`);
  assert(pr.state === 'open' && !pr.draft && !pr.merged, 'Preparation must be open');
  assert.equal(pr.user?.login, 'github-actions[bot]', 'Preparation must belong to Actions');
  assert.equal(pr.head.repo?.full_name, env.GITHUB_REPOSITORY, 'Preparation must be in this repository');
  assert.equal(pr.base.repo?.full_name, env.GITHUB_REPOSITORY);
  assert.equal(pr.base.ref, 'develop');
  assert.equal(pr.head.sha, head, 'Preparation head changed');
  const marker = preparationMarker(pr);
  assert(marker, 'Missing preparation marker');
  assert.equal(pr.head.ref, `feature/preview-${marker.version}`);
  assert.equal(env.GITHUB_REF, `refs/heads/${pr.head.ref}`);
  assert.equal(api(env.GITHUB_REPOSITORY, 'git/ref/heads/develop').object.sha, marker.source, 'Preparation source is stale');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), head);
  assertPreparation(cwd, marker.source, head, marker.version);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validatePreparationDispatch(process.cwd(), process.env, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
