---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run repository checks appropriate to the change scope before delivery. Use after implementation and before shipping.
---

# Verify

From the repository root, run the scoped verifier with the exact Node version in `.nvmrc`:

```bash
node scripts/verify-local.mjs
```

The verifier rejects a different Node version before running checks. Use `--plan` to inspect the
selected checks without running them. Plans still refresh named refs; use `--base origin/main` or
`--base <full-commit-sha>` when the default `origin/develop` is not the right comparison point.

The [CI classifier](../../../scripts/lib/ci-scope.mjs) uses the complete task diff: committed,
staged, unstaged, renamed, and untracked files. It selects typechecking, tooling, and runtime lanes
independently, combines them for mixed changes, and fails closed to the full gate for unknown scope
or unavailable history. Known documentation changes select metadata checks. Each selected check
runs once; browser and package checks share a PWA build. Logs stay in a private temporary directory
and the verifier stops at the first failure. Checks time out after 10 minutes (15 for browsers);
`--timeout-seconds <seconds>` overrides this. Cancellation stops the active process tree. Nx daemon
is disabled to avoid leaving its background server running.

Install dependencies with `pnpm install --frozen-lockfile`; install Playwright Chromium for browser
checks. Source and packed checks run generic leak scans without repository secrets or machine
configuration.

Release candidates always need full source and packed-install verification under the
[candidate policy](../release/references/automation.md#candidate-automation). Add focused behavioral
checks when selected lanes do not cover the change. Reuse successful checks only while their inputs
and environment remain unchanged; rerun affected checks after changes or failures. Required CI must
pass on the current PR head.

If generated operator skills are out of sync, run `node scripts/sync-skills.mjs` and verify again.
For repository-skill links, follow [AGENTS.md](../../../AGENTS.md#skill-sources). The leak guard
prints only `file:line`; inspect those lines locally and remove or generalize unsafe content.

For a verification-only request, report the result and stop. Continue to [ship](../ship/SKILL.md)
only when completing an already authorized implementation task, honoring draft, PR-only, or
merge-hold instructions. Failed checks block delivery; fix within scope and rerun affected checks,
or report the failure when remediation was not requested.
