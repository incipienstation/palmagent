---
name: plan
description: Scope a requested Palmagent monorepo change before implementation, or prepare an explicitly requested implementation plan. General questions and read-only investigations do not require this workflow.
---

# Plan

1. Apply [context discipline](../../../AGENTS.md#context-and-scope), reusing unchanged instructions
   already read. Load only the package, app, plugin, or documentation contracts in scope.
2. Inspect current code and relevant history when needed to decide whether to import, adapt, or build.
3. For migration work, choose one coherent working slice and sanitize every file while importing.
4. Follow the [skill source guidance](../garden/SKILL.md#skill-sources) for
   repository-maintenance skills and operator plugin skills.
5. Identify proportionate verification and explicit merge, release, or deployment gates.
6. For a plan-only request, report the plan and stop before implementation. When implementation
   is requested or already authorized, plan small commits and continue to [start](../start/SKILL.md).

## Repository boundaries

The root `palmagent` package is private and owns the product version; generated public artifacts
inherit it. Internal packages use `@palmagent/*` and remain private at `0.0.0`.
Put cross-tier contracts in `packages/shared`. Add a package or app only with its first working
slice; do not copy historical lockfiles, regenerate from declared dependencies.

## Imports from non-public sources

When importing from a non-public source, use it only as unstaged input and do not preserve its
history. Inventory and review every imported file, including code and metadata; rename identities,
remove private or stale context, and run the leak guard before committing. Report files kept
byte-identical as reusable product code; do not rewrite safe code for appearance.
