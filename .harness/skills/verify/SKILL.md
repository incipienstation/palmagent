---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run repository checks appropriate to the change scope before delivery. Use after implementation and before shipping.
---

# Verify

For documentation and skill-only edits, run from the repo root:

```bash
pnpm plugins:check
pnpm release:check
git diff --check
```

For code, dependencies, workflows, or uncertain scope, run the full local source gate:

```bash
pnpm verify
```

This includes workspace typechecking, operator skill synchronization, repository skill symlinks,
manifests, links, and leak checks.
Add focused package, runtime, or browser verification whenever the changed surface requires it.
CI selects checks from the complete PR diff under the
[CI and candidate policy](../release/references/automation.md#candidate-automation); earlier code changes
in the PR still count even when the latest commit only changes documentation.
Notes:

- If an operator plugin skill is out of sync, run `node scripts/sync-skills.mjs` (without `--check`)
  to regenerate, then re-run. For repository-maintenance skills, repair the links described in
  [AGENTS.md](../../../AGENTS.md#repository-skill-single-source).
- If the **leak guard** flags a match it prints `file:line` only (values are redacted on purpose).
  Open those lines locally and remove or generalize the content.

Green → chain into [ship](../ship/SKILL.md). Red → fix and re-run; never proceed red.
