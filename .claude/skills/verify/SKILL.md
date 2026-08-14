---
name: verify
description: Third stage of the plan → start → verify → ship loop. The pre-ship gate — run this repo's static checks and confirm they pass before landing. Use after implementing a change and before shipping.
---

# Verify

Run the gate from the repo root:

```bash
node scripts/sync-skills.mjs --check   # skill copies match the canonical (no drift)
node scripts/validate.mjs              # manifests, structure, relative links, leak guard
```

Both must print green. Notes:

- If a skill is out of sync, run `node scripts/sync-skills.mjs` (without `--check`) to regenerate,
  then re-run.
- If the **leak guard** flags a match it prints `file:line` only (values are redacted on purpose).
  Open those lines and remove the offending content — recall the decoupling rule: no other-repo
  names, paths, infra, or personal data.

Green → chain into `/ship`. Red → fix and re-run; never proceed red.
