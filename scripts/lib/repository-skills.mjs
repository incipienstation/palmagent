import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// Both platform discovery directories expose the same canonical skill folders.
export function validateRepositorySkills(root) {
  const errors = [];
  const stat = (path) => {
    try { return lstatSync(join(root, path)); } catch { return undefined; }
  };
  const directories = ['.harness/skills', '.agents/skills', '.claude/skills'];
  for (const path of directories) {
    if (!stat(path)?.isDirectory()) errors.push(`${path}: expected a real directory`);
  }
  if (errors.length) return errors;

  const names = readdirSync(join(root, directories[0]));
  if (!names.length) errors.push('.harness/skills: expected at least one repository skill');
  for (const name of names) {
    const path = `.harness/skills/${name}`;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !stat(path)?.isDirectory()) {
      errors.push(`${path}: expected a skill directory with a lowercase hyphenated name`);
    }
    if (!stat(`${path}/SKILL.md`)?.isFile()) {
      errors.push(`${path}/SKILL.md: expected a real skill file`);
    }
  }
  for (const directory of directories.slice(1)) {
    for (const name of readdirSync(join(root, directory))) {
      if (!names.includes(name)) errors.push(`${directory}/${name}: no canonical repository skill`);
    }
    for (const name of names) {
      const path = `${directory}/${name}`;
      if (!stat(path)?.isSymbolicLink()) {
        errors.push(`${path}: expected a directory symlink to the canonical repository skill`);
      } else if (readlinkSync(join(root, path)) !== `../../.harness/skills/${name}`) {
        // Do not echo an unexpected target: it could contain private host context.
        errors.push(`${path}: incorrect canonical relative target`);
      }
    }
  }
  return errors;
}
