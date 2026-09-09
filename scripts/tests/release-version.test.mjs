import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareVersion } from '../release-version.mjs';

function fixture(t, version = '0.1.0-alpha.1') {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = ['package.json', 'plugins/claude/.claude-plugin/plugin.json', 'plugins/codex/plugins/palmagent/.codex-plugin/plugin.json'];
  for (const p of paths) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), JSON.stringify({ name: 'palmagent', private: true, version })); }
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Reviewed fix.\n\n## 0.0.1\n\n- Older changes.\n');
  return { root, paths };
}

test('proposal is read-only; applying synchronizes versions and moves only Unreleased notes', (t) => {
  const { root, paths } = fixture(t);
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  assert.equal(prepareVersion(root, '0.1.0-beta.1').branch, 'develop');
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before);
  prepareVersion(root, '0.1.0-beta.1', { apply: true });
  for (const p of paths) assert.equal(JSON.parse(readFileSync(join(root, p))).version, '0.1.0-beta.1');
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /## Unreleased\n\n## 0.1.0-beta.1\n\n- Reviewed fix.\n\n## 0.0.1/);
});

test('stable promotion and next development cycle keep one product version', (t) => {
  const { root } = fixture(t, '0.1.0-rc.1');
  assert.equal(prepareVersion(root, '0.1.0', { apply: true }).branch, 'main');
  const notes = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  prepareVersion(root, '0.1.1-alpha.1', { development: true, apply: true });
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), notes);
});

test('invalid versions, backward moves and empty release notes fail before writes', (t) => {
  const { root } = fixture(t);
  const before = readFileSync(join(root, 'package.json'), 'utf8');
  for (const v of ['next', '0.1.0-alpha.01', '0.1.0+build', '0.0.1', '1.0']) assert.throws(() => prepareVersion(root, v, { apply: true }));
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n## 0.0.1\n\nOld.\n');
  assert.throws(() => prepareVersion(root, '0.1.0', { apply: true }), /reviewed changes/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before);
});
