---
name: plan
description: Scope a Palmagent implementation or an explicitly requested plan. General questions and read-only investigations do not need this workflow.
---

# Plan

Identify the affected contracts, proportionate verification, and delivery boundary. A plan-only
request stops before implementation; authorized implementation continues to [start](../start/SKILL.md).

## Repository boundaries

The root `palmagent` package is private and owns the product version; generated public artifacts
inherit it. Internal packages use `@palmagent/*` and remain private at `0.0.0`.
Cross-tier contracts belong in `packages/shared`. Add packages or apps with their first working slice.

For CLI changes, include affected operator skills and compatibility requirements from the
[CLI/plugin contract-change workflow](../release/references/channels-and-updates.md#changing-the-cli-plugin-contract).
For skill edits, use [skill source guidance](../garden/SKILL.md#skill-sources).
