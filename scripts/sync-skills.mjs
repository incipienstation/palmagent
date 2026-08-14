#!/usr/bin/env node
// Single-source skill bodies.
//
// The canonical, platform-neutral SKILL.md lives in `skills/<name>/SKILL.md`.
// It is copied verbatim into each platform tree (Claude + Codex). Editing a
// skill body = edit the canonical, then run this script. CI runs `--check` to
// forbid drift between the canonical and the generated copies.
//
// Why copies (not symlinks): consumers clone this repo directly and some clients
// (Windows / core.symlinks=false) materialize symlinks as plain text files, and
// Codex `--sparse plugins/codex` would not fetch a link target outside the cone.
// Real files in every tree are robust everywhere; this script + CI keep them in
// sync.

import {
  readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CANON = join(ROOT, 'skills');
const TARGETS = [
  join(ROOT, 'plugins/claude/skills'),
  join(ROOT, 'plugins/codex/plugins/palmagent/skills'),
];
const check = process.argv.includes('--check');

const hasSkill = (base, n) => existsSync(join(base, n, 'SKILL.md'));
const names = existsSync(CANON)
  ? readdirSync(CANON).filter((n) => hasSkill(CANON, n))
  : [];
if (names.length === 0) {
  console.error('no canonical skills found under skills/<name>/SKILL.md');
  process.exit(1);
}

const drift = [];
for (const name of names) {
  const src = readFileSync(join(CANON, name, 'SKILL.md'), 'utf8');
  for (const base of TARGETS) {
    const dest = join(base, name, 'SKILL.md');
    if (check) {
      const cur = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
      if (cur !== src) drift.push(relative(ROOT, dest));
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, src);
    }
  }
}

// A skill present in a platform tree but absent from the canonical is also drift.
if (check) {
  const canon = new Set(names);
  for (const base of TARGETS) {
    if (!existsSync(base)) continue;
    for (const n of readdirSync(base)) {
      if (hasSkill(base, n) && !canon.has(n)) {
        drift.push(`${relative(ROOT, join(base, n, 'SKILL.md'))} (no canonical source)`);
      }
    }
  }
}

if (check) {
  if (drift.length) {
    console.error('✗ skills out of sync with canonical (run: node scripts/sync-skills.mjs):');
    for (const d of drift) console.error('  - ' + d);
    process.exit(1);
  }
  console.log(`✓ skills in sync (${names.length} canonical × ${TARGETS.length} trees)`);
} else {
  console.log(`✓ synced ${names.length} skill(s) → ${TARGETS.length} platform tree(s)`);
}
