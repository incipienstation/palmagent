---
name: verify
description: Run Palmagent checks appropriate to the change scope before delivery, or report a verification-only result.
---

# Verify

For changed tests, review distinct risks and existing coverage under the
[test selection policy](../plan/references/testing.md); record coverage decisions in the PR.

After committing, use the Node version in `.nvmrc` before pushing the verified HEAD:

```bash
node scripts/verify-local.mjs
```

The default scans outgoing commit messages, filenames and changed file contents from the PR
base through HEAD, including intermediate commits. Review outgoing assets and environment-specific
content for private material that patterns cannot recognize. Rerun after amending or adding commits.
If the base cannot be fetched, pass its known full SHA with `--base` from complete local history.

Require additional local evidence only for behavior CI cannot reproduce, such as a specific device,
host integration or existing installation state. Record that result in the PR. Focused tests during
development are optional. Required CI checks the PR diff, architecture, and applicable regression
suites on the current head. Use `--extended` for offline regression testing or CI diagnosis and
`--plan` to list the selected checks. Install dependencies and Chromium as needed for extended runs.

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
