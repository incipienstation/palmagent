---
name: plan
description: Scope a requested Palmagent monorepo change before implementation, or prepare an explicitly requested implementation plan. General questions and read-only investigations do not require this workflow.
---

# Plan

1. Apply [context discipline](../../../AGENTS.md#context-discipline), reusing unchanged instructions
   already read. Load only the package, app, plugin, or documentation contracts in scope.
2. Inspect current code and relevant history when needed to decide whether to import, adapt, or build.
3. For migration work, choose one coherent working slice and sanitize every file while importing.
4. Follow the [skill source guidance](../../../AGENTS.md#repository-skill-single-source) for
   repository-maintenance skills and operator plugin skills.
5. Identify proportionate verification and explicit merge, release, or deployment gates.
6. For a plan-only request, report the plan and stop before implementation. When implementation
   is requested or already authorized, plan small commits and continue to [start](../start/SKILL.md).
