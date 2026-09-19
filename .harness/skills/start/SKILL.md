---
name: start
description: Second stage of the plan → start → verify → ship loop. Start implementation in an isolated git worktree on a feature/* branch from develop. Use when starting implementation.
---

# Start

1. Apply [context discipline](../../../AGENTS.md#context-discipline) and inspect the current checkout
   and worktrees. Reuse an existing task-owned linked worktree when appropriate; preserve unrelated changes.
2. For a new feature, fetch `origin develop` and create an isolated linked worktree with a
   `feature/<slug>` branch from `origin/develop`. For example, from the main checkout:
   `git worktree add .harness/worktrees/<slug> -b feature/<slug> origin/develop`.
   Run subsequent commands and edits in that worktree. If the platform provides a worktree tool,
   use it as required by its hooks, then create the feature branch from the fetched `origin/develop`.
   Compare that checkout's `AGENTS.md` and relevant skills with the working-file contents already
   read, including local edits. Reuse identical instructions; read differences or missing context
   before editing, as required by context discipline.
3. Make the scoped change, following the repository's
   [skill source guidance](../../../AGENTS.md#repository-skill-single-source) when editing skills.
4. Apply the public-safety rule while importing or writing every file. Then [verify](../verify/SKILL.md).
