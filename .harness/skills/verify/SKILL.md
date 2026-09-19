---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run repository checks appropriate to the change scope before delivery. Use after implementation and before shipping.
---

# Verify

Run the scoped local verifier from the repository root:

```bash
node scripts/verify-local.mjs
```

Activate the exact Node version in `.nvmrc` first (for nvm: `nvm install && nvm use`).
CI uses the same pin. Execution rejects a different Node version before checks start;
`--plan` remains available without changing the active runtime.

Use `--plan` to show the selected checks without running them. The command refreshes
`origin/develop` before classifying; use `--base origin/main` for a different target or
`--base <full-commit-sha>` for an explicitly pinned base. A plan still refreshes named refs.
It never stages, commits, opens PRs, merges, or publishes.

The verifier uses the [CI classifier](../../../scripts/lib/ci-scope.mjs) on the complete task
diff, including committed, staged, unstaged, renamed, and untracked files. Known documentation
changes select metadata checks. Typechecking, tooling, and runtime checks are selected independently:
reviewed tooling tests need no typecheck, and browser-case/snapshot-only changes need neither
typechecking nor tooling. Mixed changes retain the union; unknown scope or unavailable history
selects every lane. Selected checks run once, with one PWA build
shared by browser and package checks. Logs stay in a private temporary directory; the command
reports each result and stops at the first failure. Inspect relevant log excerpts to diagnose it.
Steps time out after 10 minutes (15 for browser checks); `--timeout-seconds <seconds>` overrides
the limit for a slow machine. Timeout returns 124; SIGINT/SIGTERM cancel the active check and
return 130/143. On POSIX, cancellation targets its process group; Windows uses `taskkill /T`.
Cancellation allows two seconds for graceful exit before forced termination.
The runner disables the Nx daemon so verification does not leave its background server behind.

Install dependencies with `pnpm install --frozen-lockfile` before code checks and install Playwright
Chromium before browser checks. Packed checks require the private `LEAK_DENYLIST`; when it is
missing, the verifier runs the selected source checks, then stops before packaging with a nonzero
exit. Report the source results and incomplete package verification, and require the trusted PR's
packed checks to pass before delivery. Do not substitute an empty or invented denylist.

Release candidates retain full source and packed-install verification under the
[CI and candidate policy](../release/references/automation.md#candidate-automation).
Add focused behavioral checks when the change needs evidence beyond the selected lanes.
Reuse successful checks only for unchanged inputs and environment; repeat affected checks after
fixes, new changes, or invalidated evidence. Required CI still runs on the current PR head.

Notes:

- If an operator plugin skill is out of sync, run `node scripts/sync-skills.mjs` (without `--check`)
  to regenerate, then re-run. For repository-maintenance skills, repair the links described in
  [AGENTS.md](../../../AGENTS.md#repository-skill-single-source).
- If the **leak guard** flags a match it prints `file:line` only (values are redacted on purpose).
  Open those lines locally and remove or generalize the content.

For a verification-only request, report results and stop. Continue to [ship](../ship/SKILL.md)
only when completing an already authorized implementation task, honoring draft, PR-only, or
merge-hold instructions. Failed checks block delivery; fix within the authorized scope and rerun
affected checks, or report the failure when remediation was not requested.
