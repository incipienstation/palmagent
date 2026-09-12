---
name: plan
description: First stage of Palmagent's plan → start → verify → ship loop. Scope a monorepo change before editing, read AGENTS.md and the relevant package or plugin contracts, and decide a small-commit plan. Use when picking up or beginning a task.
---

# Plan

1. Read the current checkout's [AGENTS.md](../../../AGENTS.md#context-discipline) and the exact
   package, app, plugin, or documentation contracts in scope; refresh older injected guidance
   under its context discipline before deciding that human input is needed.
2. Inspect current code and history before deciding whether to import, adapt, or build.
3. For migration work, choose one coherent working slice and sanitize every file while importing.
4. Follow the [skill source guidance](../../../AGENTS.md#repository-skill-single-source) for
   repository-maintenance skills and operator plugin skills.
5. Identify proportionate verification and explicit merge, release, or deployment gates.
6. Plan small commits, then hand off to [start](../start/SKILL.md).
