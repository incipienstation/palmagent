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

For ordinary PRs the default checks public content, diff integrity, and applicable backend architecture
across the complete task diff. Exercise the changed behavior before pushing. Use the nearest test or
direct inspection: check layout at the affected viewport, reproduce the server failure, or exercise
recovery with existing data. Record the result in the PR. Keep local-only device, host, migration,
and contract evidence required for the change.

Required CI runs the selected regression suites on the current PR head. For offline work or to
investigate a CI failure, `--extended` runs the previous scope-selected suites locally.
`--plan` lists the checks. Named bases refresh even for plans; use `--base <full-sha>` for an
available offline base. Unavailable history selects the full local gate. Install dependencies and
Chromium as needed.

`--resume <previous-log-directory>` selects extended mode and reuses successful source checks with
matching inputs and environment. Build and artifact checks rerun. Use a fresh run after external
tool or service changes. Logs are private temporary files. Checks time out after 10 minutes
(15 for browsers); override with `--timeout-seconds <seconds>`.

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
