---
name: garden
description: Audit documentation, skills, and AGENTS.md for unnecessary or inconsistent context. Propose scoped cleanup, apply confirmed changes, and guide repository or operator skill authoring.
---

# Garden

Optimize for useful, consistent context, not length alone.

## Audit and propose

- Stay read-only unless the user has already approved a cleanup scope.
- Trace agreements and supersession in documents, history, and user decisions. Distinguish agreed requirements, unapproved proposals, implementation records, and replaced decisions. Age or missing code does not make a requirement obsolete; report implementation gaps separately.
- Propose removing redundant or irrelevant context and consolidating duplication with canonical links. Preserve unique requirements, conditions, exceptions, rationale, and useful verification evidence.
- Report each finding's file or section, evidence, proposed change, and unresolved questions compactly. Preserve uncertain content and obtain confirmation for cleanup that is not already authorized.

## Confirmed cleanup

- Recheck approved findings against current files and follow the repository's [branching, delivery, and verification guidance](../../../AGENTS.md).
- Preserve meaning and repair affected links. Do not change product decisions or implementation to resolve documentation gaps.
- Leave newly discovered changes outside the approved scope untouched and report them separately.

## Skill sources

For skill authoring or edits, use these canonical sources:

- Author repository-maintenance skills in `.harness/skills/<name>/SKILL.md`; add
  `.agents/skills/<name>` and `.claude/skills/<name>` as relative directory symlinks to that source.
  `pnpm plugins:check` validates them. Keep Claude-specific hooks and settings under `.claude/`.
- Author operator skills in `skills/<name>/SKILL.md` and shared references in `skills/.shared/`.
  Run `node scripts/sync-skills.mjs` to update Claude and Codex copies; never edit generated copies
  by hand or add `SKILL.md` under `.shared/`. Keep platform manifests and Codex
  `agents/openai.yaml` files platform-specific.
