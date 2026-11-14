---
name: verify
description: Run Palmagent checks appropriate to the change scope before delivery, or report a verification-only result.
---

# Verify

For changed tests, review distinct risks and existing coverage under the
[test selection policy](../plan/references/testing.md); record coverage decisions in the PR.

Use the exact Node version in `.nvmrc`:

```bash
node scripts/verify-local.mjs
```

The verifier selects checks from the complete task diff, shares the PWA build, and keeps full logs
in a private temporary directory. Unknown scope or unavailable history selects the full gate.
`--plan` previews checks; `--base <remote/branch|full-sha>` overrides `origin/develop`.
Named refs refresh even with `--plan`. Install dependencies and Chromium when selected checks need them.

After a failure or interruption, use `--resume <previous-log-directory>` to reuse successful source
checks with unchanged inputs and environment. Changed inputs invalidate reuse; build and artifact
checks always rerun. Run without `--resume` for fresh evidence or changed external tools/services.
Checks time out after 10 minutes (15 for browsers); override with `--timeout-seconds <seconds>`.

Add behavioral checks where selected lanes leave a gap. Required CI must pass on the current PR head.
Release candidates require the full [candidate policy](../release/references/automation.md#candidate-automation).
CLI breaking changes also require accepted and rejected CLI/plugin pair checks under the
[contract-change workflow](../release/references/channels-and-updates.md#changing-the-cli-plugin-contract).

Verification-only requests end with the result. Authorized implementation continues to
[ship](../ship/SKILL.md), respecting draft, PR-only, and merge-hold requests.

## Waiting for checks

Keep one process/session per check or CI watcher. Work while it runs; otherwise wait on that same
execution for up to 60 seconds. Resume yielded wrappers before polling their child processes.
Read logs for failures or stalls, not repeated healthy status. An interrupted watcher or missing
required-check entry is not a pass.
