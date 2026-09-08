import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectPackage } from '../lib/package-artifact.mjs';
import { packageFixture, commit } from './package-fixture.mjs';

for (const [name, options, expected] of [
  ['clean identity', {}, null], ['dirty build', { dirty: true }, /clean source/],
  ['missing identity', { legacy: true }, /no source/], ['lifecycle hook', { scripts: { postinstall: 'exit 1' } }, /lifecycle/],
]) test(name, () => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-artifact-test-'));
  try {
    const { path } = packageFixture(root, options);
    if (expected) assert.throws(() => inspectPackage(path), expected);
    else {
      assert.equal(inspectPackage(path, { commit, publishable: true }).sourceCommit, commit);
      assert.throws(() => inspectPackage(path, { commit: 'b'.repeat(40) }), /commit mismatch/);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test('legacy snapshot allowed only explicitly; symlinks rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-artifact-test-'));
  try {
    const fixture = packageFixture(root, { legacy: true });
    assert.equal(inspectPackage(fixture.path, { allowLegacy: true }).sourceCommit, null);
    symlinkSync('cli.js', join(fixture.directory, 'link.js'));
    execFileSync('tar', ['-czf', fixture.path, '-C', root, 'package']);
    assert.throws(() => inspectPackage(fixture.path, { allowLegacy: true }), /links/);
  } finally { rmSync(root, { recursive: true }); }
});
