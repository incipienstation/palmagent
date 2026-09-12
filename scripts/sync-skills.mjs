#!/usr/bin/env node
// Canonical operator skill bodies and shared references are copied verbatim into
// both plugin packages. Real files keep each installed plugin self-contained.
// Platform manifests and agents/openai.yaml remain outside this sync boundary.
import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function sharedFiles(base) {
  const directory = join(base, '.shared');
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).map((entry) => {
    if (!entry.isFile() || entry.name === 'SKILL.md') {
      throw new Error('skills/.shared must contain supporting files only, without SKILL.md');
    }
    return join('.shared', entry.name);
  });
}

export function syncSkills(root, { check = false } = {}) {
  const canonical = join(root, 'skills');
  const targets = [join(root, 'plugins/claude/skills'), join(root, 'plugins/codex/plugins/palmagent/skills')];
  const hasSkill = (base, name) => existsSync(join(base, name, 'SKILL.md'));
  const names = existsSync(canonical)
    ? readdirSync(canonical).filter((name) => name !== '.shared' && hasSkill(canonical, name))
    : [];
  if (!names.length) throw new Error('no canonical skills found under skills/<name>/SKILL.md');

  const shared = sharedFiles(canonical);
  // Inventory before writes so invalid supporting entries cannot cause a partial sync.
  const inventories = targets.map(sharedFiles);
  const files = [...names.map((name) => join(name, 'SKILL.md')), ...shared];
  const drift = [];
  for (const file of files) {
    const source = readFileSync(join(canonical, file));
    for (const base of targets) {
      const destination = join(base, file);
      if (check) {
        if (!existsSync(destination) || !readFileSync(destination).equals(source)) {
          drift.push(relative(root, destination));
        }
      } else {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, source);
      }
    }
  }

  for (const [index, base] of targets.entries()) {
    // Only .shared is fully managed: remove obsolete helper copies, never platform wrappers.
    for (const file of inventories[index]) {
      if (shared.includes(file)) continue;
      const destination = join(base, file);
      if (check) drift.push(`${relative(root, destination)} (no canonical source)`);
      else rmSync(destination);
    }
    if (check && existsSync(base)) {
      for (const name of readdirSync(base)) {
        if (hasSkill(base, name) && !names.includes(name)) {
          drift.push(`${relative(root, join(base, name, 'SKILL.md'))} (no canonical source)`);
        }
      }
    }
  }
  return { skillCount: names.length, sharedCount: shared.length, drift };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const check = process.argv.includes('--check');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const result = syncSkills(root, { check });
    if (result.drift.length) {
      console.error('✗ skills or shared references out of sync (run: node scripts/sync-skills.mjs):');
      for (const path of result.drift) console.error(`  - ${path}`);
      process.exitCode = 1;
    } else {
      console.log(`✓ ${check ? 'in sync' : 'synced'}: ${result.skillCount} skills + ${result.sharedCount} shared files × 2 platform trees`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
