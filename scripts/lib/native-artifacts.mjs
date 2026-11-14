import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const supported = ['linux-x64', 'linux-arm64'];
const contracts = { protocol: 1, hostReadiness: 1, applicationRuntime: 1, routineHost: 1 };
const regularFile = path => {
  assert(lstatSync(path).isFile(), 'Native artifact must be a regular file');
  return readFileSync(path);
};

// Inputs are artifacts from successful builders in this workflow run, not a cache.
// Check every input before replacing output, including binaries whose executable
// bits GitHub artifact downloads do not preserve.
export function importNativeArtifacts(input, output, { version, sourceCommit, platforms = supported }) {
  assert(platforms.length > 0 && new Set(platforms).size === platforms.length
    && platforms.every(platform => supported.includes(platform)), 'Unsupported native platforms');
  const manifest = { ...contracts, version, sourceCommit, artifacts: {}, applicationArtifacts: {} };
  const files = [];
  for (const platform of platforms) {
    const directory = join(input, `native-${platform}`);
    assert(lstatSync(directory).isDirectory() && lstatSync(join(directory, platform)).isDirectory(), 'Native artifact directories must not be links');
    const candidate = JSON.parse(regularFile(join(directory, 'manifest.json')));
    assert(candidate.version === version && candidate.sourceCommit === sourceCommit, 'Native artifact source identity mismatch');
    for (const [key, expected] of Object.entries(contracts)) assert(candidate[key] === expected, 'Native artifact contract mismatch');
    for (const [name, field] of [['palmagentd', 'artifacts'], ['palmagent-runtime', 'applicationArtifacts']]) {
      assert.deepEqual(Object.keys(candidate[field] ?? {}), [platform], 'Native artifact platform mismatch');
      const content = regularFile(join(directory, platform, name));
      const hash = createHash('sha256').update(content).digest('hex');
      assert(candidate[field][platform] === hash, 'Native artifact checksum mismatch');
      manifest[field][platform] = hash;
      files.push({ platform, name, content });
    }
  }
  rmSync(output, { recursive: true, force: true });
  for (const { platform, name, content } of files) {
    mkdirSync(join(output, platform), { recursive: true });
    const path = join(output, platform, name);
    writeFileSync(path, content);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}
