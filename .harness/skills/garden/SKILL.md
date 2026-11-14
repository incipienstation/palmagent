---
name: garden
description: Audit documentation, skills, and AGENTS.md for unnecessary or inconsistent context. Propose scoped cleanup, apply confirmed changes, and guide repository or operator skill authoring.
---

# Garden

Audit read-only unless cleanup is authorized. Propose scoped removals of redundant context while
preserving distinct requirements and unresolved decisions. Age or missing implementation does not
make a requirement obsolete. Apply approved cleanup through [plan](../plan/SKILL.md).

## Skill sources

For skill authoring or edits, use these canonical sources:

- Author repository-maintenance skills in `.harness/skills/<name>/SKILL.md`; add
  `.agents/skills/<name>` and `.claude/skills/<name>` as relative directory symlinks to that source.
  `pnpm plugins:check` validates them. Keep Claude-specific hooks and settings under `.claude/`.
- Author operator skills in `skills/<name>/SKILL.md` and shared references in `skills/.shared/`.
  Run `node scripts/sync-skills.mjs` to update Claude and Codex copies; never edit generated copies
  by hand or add `SKILL.md` under `.shared/`. Keep platform manifests and Codex
  `agents/openai.yaml` files platform-specific.
