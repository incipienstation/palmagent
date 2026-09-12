import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { syncSkills } from '../sync-skills.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-skill-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const skill = '---\nname: install\ndescription: Install a service.\n---\nRead [bootstrap](../.shared/bootstrap.md).\n';
  const reference = 'Use one exact published version.\n';
  write('skills/install/SKILL.md', skill);
  write('skills/.shared/bootstrap.md', reference);
  const targets = ['plugins/claude/skills', 'plugins/codex/plugins/palmagent/skills'];
  for (const base of targets) write(`${base}/install/agents/openai.yaml`, 'platform-specific\n');
  return { root, write, skill, reference, targets };
}

test('both installed layouts resolve the same shared reference without adding a skill', (t) => {
  const { root, targets, skill, reference } = fixture(t);
  assert.deepEqual(syncSkills(root), { skillCount: 1, sharedCount: 1, drift: [] });
  for (const base of targets) {
    const directory = join(root, base, 'install');
    assert.equal(readFileSync(join(directory, 'SKILL.md'), 'utf8'), skill);
    assert.equal(readFileSync(resolve(directory, '../.shared/bootstrap.md'), 'utf8'), reference);
    assert.equal(existsSync(join(root, base, '.shared/SKILL.md')), false);
    assert.equal(readFileSync(join(directory, 'agents/openai.yaml'), 'utf8'), 'platform-specific\n');
  }
  assert.deepEqual(syncSkills(root, { check: true }).drift, []);
});

test('check reports missing or changed helpers without writing, and sync repairs them', (t) => {
  const { root, targets, write } = fixture(t);
  const missing = syncSkills(root, { check: true });
  assert.equal(missing.drift.length, 4);
  assert.equal(existsSync(join(root, targets[0], '.shared')), false);
  syncSkills(root);
  write(`${targets[0]}/.shared/bootstrap.md`, 'outdated policy\n');
  rmSync(join(root, targets[1], '.shared/bootstrap.md'));
  assert.deepEqual(syncSkills(root, { check: true }).drift, targets.map((base) => `${base}/.shared/bootstrap.md`));
  assert.equal(readFileSync(join(root, targets[0], '.shared/bootstrap.md'), 'utf8'), 'outdated policy\n');
  syncSkills(root);
  assert.deepEqual(syncSkills(root, { check: true }).drift, []);
});

test('obsolete helpers are removed while platform metadata and stale skill reporting are preserved', (t) => {
  const { root, targets, write } = fixture(t);
  syncSkills(root);
  write(`${targets[0]}/.shared/obsolete.md`, 'retired instructions\n');
  write(`${targets[0]}/old-skill/SKILL.md`, 'Old skill\n');
  assert.equal(syncSkills(root, { check: true }).drift.length, 2);
  syncSkills(root);
  assert.equal(existsSync(join(root, targets[0], '.shared/obsolete.md')), false);
  assert.equal(readFileSync(join(root, targets[0], 'install/agents/openai.yaml'), 'utf8'), 'platform-specific\n');
  assert.deepEqual(syncSkills(root, { check: true }).drift, [`${targets[0]}/old-skill/SKILL.md (no canonical source)`]);
});

test('removing a canonical helper also removes its generated copies', (t) => {
  const { root, targets } = fixture(t);
  syncSkills(root);
  rmSync(join(root, 'skills/.shared/bootstrap.md'));
  assert.equal(syncSkills(root, { check: true }).drift.length, 2);
  syncSkills(root);
  for (const base of targets) assert.equal(existsSync(join(root, base, '.shared/bootstrap.md')), false);
});

test('shared files cannot accidentally become another discoverable skill', (t) => {
  const { root, write, targets } = fixture(t);
  write('skills/.shared/SKILL.md', 'unexpected skill');
  assert.throws(() => syncSkills(root), /supporting files only/);
  assert.equal(existsSync(join(root, targets[0], 'install/SKILL.md')), false);
});
