---
name: verify
description: Third stage of Palmagent's plan → start → verify → ship loop. Run repository checks appropriate to the change scope before delivery. Use after implementation and before shipping.
---

# Verify

From the repository root, run the scoped verifier with the exact Node version in `.nvmrc`:

```bash
node scripts/verify-local.mjs
```

`pnpm verify` runs the full local source gate. Build the PWA before reusing
`web:verify:built` or `pkg:assemble` output.

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

For Palmagent CLI breaking changes, verify the accepted new CLI/plugin pair and rejected
incompatible pairs under the [contract-change workflow](../release/references/channels-and-updates.md#changing-the-cli-plugin-contract).
Require synchronized release manifests, updated affected operator guidance, and the declared
compatibility boundary before shipping; matching manifest versions alone do not prove compatibility.

If generated operator skills are out of sync, run `node scripts/sync-skills.mjs` and verify again.
For repository-skill links, follow [skill source guidance](../garden/SKILL.md#skill-sources).
`scripts/validate.mjs` checks version-controlled source and prints only `file:line`; inspect those
lines locally and remove or generalize unsafe content.

For a verification-only request, report the result and stop. Continue to [ship](../ship/SKILL.md)
only when completing an already authorized implementation task, honoring draft, PR-only, or
merge-hold instructions. Failed checks block delivery; fix within scope and rerun affected checks,
or report the failure when remediation was not requested.

## Waiting for checks

Keep the running check's process/session ID and do independent work while it runs. When only
waiting remains, use completion notifications or request a 60-second blocking wait on that process
(the tool's maximum if shorter); completion may return sooner. Consume the returned status in
that call; avoid separate `sleep` then status-query turns. If a tool wrapper yields, resume its existing execution before
polling the child process. Keep outer wait budgets long enough to cover nested waits where supported.

Report meaningful state changes and keep required progress updates concise. Read additional log
excerpts when a failure, stall, or next decision needs them; do not repeatedly tail healthy logs.
Confirm the terminal result before reporting success. Restart only after establishing that the
previous check ended or was cancelled, and rerun checks only under the evidence-reuse rules above.
