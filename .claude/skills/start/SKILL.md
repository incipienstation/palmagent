---
name: start
description: Second stage of the plan → start → verify → ship loop. Enter a git worktree (edits are hook-enforced to worktrees) and branch a feature/* off develop. Use when starting implementation.
---

# Start

1. `EnterWorktree` — edits are blocked in the main checkout by a hook.
2. Branch off **`develop`** (fetch first): `git checkout -b feature/<slug> origin/develop`.
3. Read `AGENTS.md`, then make the scoped change. For an operator plugin skill body, edit the
   **canonical** `skills/<name>/SKILL.md`, then run `node scripts/sync-skills.mjs` to regenerate
   the platform copies — never hand-edit the generated copies under `plugins/`.
4. Apply the public-safety rule while importing or writing every file. Then `/verify`.
