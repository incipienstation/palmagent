# AGENTS.md

Guidance for coding agents maintaining the Palmagent repository.

## Context and scope

- At task start, read current instructions and only the skills and references needed. Reuse unchanged
  instructions; after switching checkouts or before relying on a rule to pause, compare current files,
  including local edits. Read changed or missing context.
- Use current files, history, and the user's latest decisions over stale snapshots. Carry authorization
  through follow-ups in the same scope; ask only about unresolved ambiguity or new actions.
- Read linked references when they affect a decision. Keep searches and output focused; store full
  test logs outside the repository and inspect relevant excerpts.
- Write human-facing guidance in `README.md` or `docs/`; keep agent workflow in `AGENTS.md` and skills.

## Product UI

- Make actions discoverable through familiar controls, clear visual states, and direct feedback.
  Prefer improving the interaction over adding persistent instructions for gestures or basic controls.
- Keep gesture shortcuts optional: provide visible, keyboard-accessible controls with accessible
  names. Retain concise labels and feedback needed to understand state, errors, or consequences.
- Embedded previews should preserve the surrounding content's scrolling. Put gestures that compete
  with reading, such as diagram zoom and pan, in an explicitly opened viewer.

## Public safety

Treat every committed byte and commit as public. Never include secrets, personal paths, private
domains, host inventories, production data, transcripts, databases, or private-repository
references. Use explicit placeholders for environment-specific examples.

## Task routing

Read the relevant skill before its stage or action; load supporting references only as needed.

- Implementation: [plan](.harness/skills/plan/SKILL.md) →
  [start](.harness/skills/start/SKILL.md) → [verify](.harness/skills/verify/SKILL.md) →
  [ship](.harness/skills/ship/SKILL.md).
- Verification-only requests: [verify](.harness/skills/verify/SKILL.md).
- Documentation or instruction cleanup and skill authoring:
  [garden](.harness/skills/garden/SKILL.md).
- Release intervention, version/tag/publication changes, `main` merges, hotfixes,
  merge-policy or repository-visibility changes: [release](.harness/skills/release/SKILL.md).
- Host operations: [validation environments](docs/STAGING.md) and the relevant operator skill.
