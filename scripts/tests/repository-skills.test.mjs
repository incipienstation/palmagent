import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRepositorySkills } from '../lib/repository-skills.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'palmagent-repository-skills-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.harness/skills/plan'), { recursive: true });
  writeFileSync(join(root, '.harness/skills/plan/SKILL.md'), '---\nname: plan\ndescription: Plan a change.\n---\n');
  for (const platform of ['.agents', '.claude']) {
    mkdirSync(join(root, platform, 'skills'), { recursive: true });
    symlinkSync('../../.harness/skills/plan', join(root, platform, 'skills/plan'));
  }
  return root;
}

test('both platforms read the same canonical skill, including subsequent edits', (t) => {
  const root = fixture(t);
  const canonical = join(root, '.harness/skills/plan/SKILL.md');
  writeFileSync(canonical, 'Updated shared instructions\n');
  assert.deepEqual(validateRepositorySkills(root), []);
  for (const platform of ['.agents', '.claude']) {
    assert.equal(readFileSync(join(root, platform, 'skills/plan/SKILL.md'), 'utf8'), readFileSync(canonical, 'utf8'));
  }
});

for (const platform of ['.agents', '.claude']) {
  test(`${platform}: missing or copied skill cannot replace a discovery symlink`, (t) => {
    const root = fixture(t);
    const path = join(root, platform, 'skills/plan');
    rmSync(path);
    assert.match(validateRepositorySkills(root).join('\n'), /expected a directory symlink/);
    mkdirSync(path);
    writeFileSync(join(path, 'SKILL.md'), 'Independent copy');
    assert.match(validateRepositorySkills(root).join('\n'), /expected a directory symlink/);
  });

  for (const target of ['../../.harness/skills/missing', '../plan', '/outside/skills/plan']) {
    test(`${platform}: rejects an incorrect target without exposing its value`, (t) => {
      const root = fixture(t);
      const path = join(root, platform, 'skills/plan');
      rmSync(path);
      symlinkSync(target, path);
      assert.deepEqual(validateRepositorySkills(root), [`${platform}/skills/plan: incorrect canonical relative target`]);
    });
  }

  test(`${platform}: rejects stale discovery entries`, (t) => {
    const root = fixture(t);
    symlinkSync('../../.harness/skills/missing', join(root, platform, 'skills/stale'));
    assert.deepEqual(validateRepositorySkills(root), [`${platform}/skills/stale: no canonical repository skill`]);
  });
}

test('requires canonical files and real source directories', (t) => {
  const root = fixture(t);
  rmSync(join(root, '.harness/skills/plan/SKILL.md'));
  assert.match(validateRepositorySkills(root).join('\n'), /expected a real skill file/);
  rmSync(join(root, '.harness/skills/plan'), { recursive: true });
  symlinkSync('../../.agents/skills/plan', join(root, '.harness/skills/plan'));
  assert.match(validateRepositorySkills(root).join('\n'), /expected a skill directory/);
});

test('requires nonempty canonical and real platform directories', (t) => {
  const root = fixture(t);
  rmSync(join(root, '.harness/skills/plan'), { recursive: true });
  assert.match(validateRepositorySkills(root).join('\n'), /expected at least one repository skill/);
  rmSync(join(root, '.agents/skills'), { recursive: true });
  symlinkSync('../.harness/skills', join(root, '.agents/skills'));
  assert.deepEqual(validateRepositorySkills(root), ['.agents/skills: expected a real directory']);
});
