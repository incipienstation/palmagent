---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run the complete repository gate and any scope-specific runtime checks before delivery. Use after implementation and before shipping.
---

# Verify

Run the current complete gate from the repo root:

```bash
pnpm verify
```

This includes workspace typechecking, operator skill synchronization, repository skill symlinks,
manifests, links, and leak checks.
Add focused package, runtime, or browser verification whenever the changed surface requires it.
Notes:

- If an operator plugin skill is out of sync, run `node scripts/sync-skills.mjs` (without `--check`)
  to regenerate, then re-run. For repository-maintenance skills, repair the links described in
  [AGENTS.md](../../../AGENTS.md#repository-skill-single-source).
- If the **leak guard** flags a match it prints `file:line` only (values are redacted on purpose).
  Open those lines locally and remove or generalize the content.

Green → chain into [ship](../ship/SKILL.md). Red → fix and re-run; never proceed red.
