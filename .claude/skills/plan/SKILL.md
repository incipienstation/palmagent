---
name: plan
description: First stage of Palmagent's plan → start → verify → ship loop. Scope a monorepo change before editing, read AGENTS.md and the relevant package or plugin contracts, and decide a small-commit plan. Use when picking up or beginning a task.
---

# Plan

1. Read `AGENTS.md` and the exact package, app, plugin, or documentation contracts in scope.
2. Inspect current code and history before deciding whether to import, adapt, or build.
3. For migration work, choose one coherent working slice and sanitize every file while importing.
4. For plugin skill bodies, edit only `skills/<name>/SKILL.md`; generated platform copies are not
   independent sources.
5. Identify proportionate verification and explicit merge, release, or deployment gates.
6. Plan small commits, then hand off to `/start`.
