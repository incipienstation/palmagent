---
name: plan
description: Scope a requested Palmagent monorepo change before implementation, or prepare an explicitly requested implementation plan. General questions and read-only investigations do not require this workflow.
---

# Plan

1. Apply [context discipline](../../../AGENTS.md#context-and-scope), reusing unchanged instructions
   already read. Load only the package, app, plugin, or documentation contracts in scope.
2. Inspect current code and relevant history when needed to decide whether to import, adapt, or build.
3. Follow the [skill source guidance](../garden/SKILL.md#skill-sources) for
   repository-maintenance skills and operator plugin skills.
4. Identify proportionate verification and explicit merge, release, or deployment gates.
5. For a plan-only request, report the plan and stop before implementation. When implementation
   is requested or already authorized, plan small commits and continue to [start](../start/SKILL.md).

## Repository boundaries

The root `palmagent` package is private and owns the product version; generated public artifacts
inherit it. Internal packages use `@palmagent/*` and remain private at `0.0.0`.
Put cross-tier contracts in `packages/shared`. Add a package or app only with its first working
slice. Regenerate lockfiles from declared dependencies.
