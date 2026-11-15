import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Runner setup overlaps the producer. A missing artifact is never a cache miss:
// consumers must fail rather than silently build and test different PWA bytes.
export function findArtifact(response, runId) {
  assert(Array.isArray(response.artifacts) && response.total_count === response.artifacts.length,
    'Incomplete workflow artifact listing');
  const matches = response.artifacts.filter(artifact => artifact.name === 'ci-pwa');
  assert(matches.length <= 1, 'Ambiguous PWA artifact');
  if (!matches.length) return undefined;
  const artifact = matches[0];
  assert(typeof artifact.expired === 'boolean' && Number.isSafeInteger(artifact.id) && artifact.id > 0
    && String(artifact.workflow_run?.id) === runId, 'Invalid PWA artifact identity');
  // An expired upload cannot be read. Let the producer replace it while consumers wait.
  return artifact.expired ? undefined : artifact.id;
}

export async function waitForArtifact({ query, runId, now = Date.now, sleep = setTimeout, timeout = 180_000 }) {
  const started = now();
  while (now() - started < timeout) {
    const id = findArtifact(await query(), runId);
    if (id) return { id, seconds: ((now() - started) / 1000).toFixed(1) };
    await sleep(Math.min(2000, Math.max(0, timeout - (now() - started))));
  }
  throw new Error('Shared PWA was not available within the bounded wait; check the pwa job.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    assert(['find', 'wait'].includes(mode), 'Expected find or wait');
    const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && /^\d+$/.test(runId ?? ''), 'Missing workflow identity');
    const query = () => JSON.parse(execFileSync('gh', [
      'api', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const result = mode === 'find' ? { id: findArtifact(query(), runId) } : await waitForArtifact({ runId, query });
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${result.id ?? ''}\n`);
    if (mode === 'wait') console.log(`Shared PWA ready after ${result.seconds}s (artifact ${result.id}).`);
    else console.log(result.id ? `Reuse immutable run PWA (artifact ${result.id}).` : 'No reusable run PWA; build once.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
