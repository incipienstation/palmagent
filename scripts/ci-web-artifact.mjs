import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

class IncompleteListing extends Error {}

export function findArtifact(response, runId) {
  assert(Array.isArray(response.artifacts) && Number.isSafeInteger(response.total_count)
    && response.total_count >= 0 && response.total_count <= 100, 'Invalid workflow artifact listing');
  const matches = response.artifacts.filter(artifact => artifact.name === 'ci-pwa');
  assert(matches.length <= 1, 'Ambiguous PWA artifact');
  const artifact = matches[0];
  if (artifact) {
    assert(typeof artifact.expired === 'boolean' && Number.isSafeInteger(artifact.id) && artifact.id > 0
      && String(artifact.workflow_run?.id) === runId, 'Invalid PWA artifact identity');
  }
  if (response.total_count !== response.artifacts.length) throw new IncompleteListing('Incomplete workflow artifact listing');
  return artifact && !artifact.expired ? artifact : undefined;
}

// Artifact registration and archive availability can propagate at different times.
export async function retryTransfer(operation, { archive = false, sleep = setTimeout } = {}) {
  for (const delay of [1000, 2000, 4000, 8000, 0]) {
    try { return await operation(); }
    catch (error) {
      const status = /\(HTTP (\d{3})\)/.exec(String(error.stderr ?? ''))?.[1];
      const transient = error instanceof IncompleteListing || error.code === 'ETIMEDOUT'
        || ['408', '429', '500', '502', '503', '504'].includes(status) || (archive && status === '404');
      if (!transient || !delay) throw error;
      console.log(`Retrying PWA ${archive ? 'download' : 'lookup'} in ${delay / 1000}s.`);
      await sleep(delay);
    }
  }
}

export async function waitForArtifact({ query, runId, now = Date.now, sleep = setTimeout, timeout = 180_000 }) {
  const started = now();
  while (now() - started < timeout) {
    const artifact = await retryTransfer(async () => findArtifact(await query(), runId), { sleep });
    if (artifact) return { artifact, seconds: ((now() - started) / 1000).toFixed(1) };
    await sleep(Math.min(2000, Math.max(0, timeout - (now() - started))));
  }
  throw new Error('Shared PWA was not available within the bounded wait; check the pwa job.');
}

async function download(repository, artifact) {
  const staging = mkdtempSync(join(tmpdir(), 'ci-pwa-'));
  const archive = join(staging, 'artifact.zip');
  try {
    await retryTransfer(() => {
      const fd = openSync(archive, 'w', 0o600);
      try {
        execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
          stdio: ['ignore', fd, 'pipe'], timeout: 30_000,
        });
      } finally { closeSync(fd); }
    }, { archive: true });
    if (artifact.digest) {
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
      assert.equal('sha256:' + digest, artifact.digest, 'PWA archive digest mismatch');
    }
    // Extract away from the checkout and install only the two declared outputs.
    const extracted = join(staging, 'extracted');
    execFileSync('python3', ['-I', '-m', 'zipfile', '-e', archive, extracted]);
    mkdirSync('build', { recursive: true });
    for (const path of ['apps/web/dist', 'build/ci-web-cache.json']) {
      cpSync(join(extracted, path), path, { recursive: true });
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    assert(['find', 'wait'].includes(mode), 'Expected find or wait');
    const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
    assert(/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && /^\d+$/.test(runId ?? ''), 'Missing workflow identity');
    const query = () => JSON.parse(execFileSync('gh', [
      'api', `repos/${repository}/actions/runs/${runId}/artifacts?name=ci-pwa&per_page=100`,
    ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    const result = mode === 'find' ? { artifact: await retryTransfer(() => findArtifact(query(), runId)) }
      : await waitForArtifact({ runId, query });
    if (result.artifact) {
      if (result.seconds) console.log(`Shared PWA found after ${result.seconds}s.`);
      await download(repository, result.artifact);
      console.log(`Downloaded run PWA (artifact ${result.artifact.id}).`);
    } else console.log('No reusable run PWA; build once.');
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${result.artifact?.id ?? ''}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
