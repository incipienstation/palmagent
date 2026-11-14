import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importNativeArtifacts } from '../lib/native-artifacts.mjs';

const identity = { version: '1.2.3', sourceCommit: 'a'.repeat(40) };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'native-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'input'), output = join(root, 'output');
  for (const platform of ['linux-x64', 'linux-arm64']) {
    const directory = join(input, `native-${platform}`);
    mkdirSync(join(directory, platform), { recursive: true });
    const manifest = { protocol: 1, hostReadiness: 1, applicationRuntime: 1, routineHost: 1, ...identity, artifacts: {}, applicationArtifacts: {} };
    for (const [name, field] of [['palmagentd', 'artifacts'], ['palmagent-runtime', 'applicationArtifacts']]) {
      const content = `${platform}:${name}`;
      writeFileSync(join(directory, platform, name), content, { mode: 0o644 });
      manifest[field][platform] = createHash('sha256').update(content).digest('hex');
    }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  }
  return { input, output };
}

test('shared native artifacts retain both identities, hashes and executable modes; a platform consumer receives only its target', t => {
  const { input, output } = fixture(t);
  importNativeArtifacts(input, output, identity);
  const merged = JSON.parse(readFileSync(join(output, 'manifest.json')));
  assert.equal(merged.sourceCommit, identity.sourceCommit);
  for (const platform of ['linux-x64', 'linux-arm64']) {
    for (const [name, field] of [['palmagentd', 'artifacts'], ['palmagent-runtime', 'applicationArtifacts']]) {
      const path = join(output, platform, name);
      assert.equal(merged[field][platform], createHash('sha256').update(readFileSync(path)).digest('hex'));
      assert.equal(statSync(path).mode & 0o777, 0o755);
    }
  }
  importNativeArtifacts(input, output, { ...identity, platforms: ['linux-arm64'] });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(output, 'manifest.json'))).artifacts), ['linux-arm64']);
  assert.throws(() => statSync(join(output, 'linux-x64')), { code: 'ENOENT' });
});

test('stale, incompatible, incomplete, corrupt and linked native artifacts fail before replacing output', t => {
  const { input, output } = fixture(t);
  const path = join(input, 'native-linux-arm64', 'manifest.json');
  const original = readFileSync(path, 'utf8');
  mkdirSync(output); writeFileSync(join(output, 'retained'), 'previous');
  for (const change of [
    m => { m.sourceCommit = 'b'.repeat(40); },
    m => { m.version = '2.0.0'; },
    m => { m.applicationRuntime = 2; },
    m => { m.artifacts = {}; },
    m => { m.applicationArtifacts['linux-arm64'] = '0'.repeat(64); },
  ]) {
    const manifest = JSON.parse(original); change(manifest);
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => importNativeArtifacts(input, output, identity));
    assert.equal(readFileSync(join(output, 'retained'), 'utf8'), 'previous');
  }
  writeFileSync(path, original);
  const binary = join(input, 'native-linux-arm64/linux-arm64/palmagentd');
  rmSync(binary); symlinkSync(path, binary);
  assert.throws(() => importNativeArtifacts(input, output, identity), /regular file/);
  rmSync(join(input, 'native-linux-arm64'), { recursive: true });
  assert.throws(() => importNativeArtifacts(input, output, identity), { code: 'ENOENT' });
  assert.equal(readFileSync(join(output, 'retained'), 'utf8'), 'previous');
});
