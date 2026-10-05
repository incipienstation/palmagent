# Codex compatibility verification

The declared Codex range is `>=0.154.0 <0.160.1`. It retains the previous
0.154.0 through 0.157.1 range and extends support through 0.160.0.
The shared metadata is copied to both operator plugins by `node scripts/sync-skills.mjs`.

On 2026-09-27, authenticated tests against Codex CLI 0.154.0, 0.155.0,
0.155.1, 0.156.0, 0.156.1, 0.157.0, and 0.157.1 exercised both `CodexRunner`
execution paths on Linux ARM64 with Node 24.21.0. Every listed version passed:

| Behavior | `exec` | `app-server` |
| --- | --- | --- |
| New session and successful terminal result | Passed | Passed |
| Resume the same session and recall prior-turn context | Passed | Passed |
| Real shell output, matching call/result identity, intentional exit code 7 | Passed | Passed |
| Nonexistent model produces an error, never a successful result | Passed | Passed |
| Stop during a sleeping shell command | SIGINT fallback | `turn/interrupt` |
| Resume the stopped session and complete another turn | Passed | Passed |

On 2026-10-05, Codex CLI 0.160.0 passed the same authenticated matrix on
Linux ARM64 with Node 24.21.0 for both execution paths. The first run stopped
when the provider reported that the selected model was at capacity; a complete
retry passed every scenario. Versions between 0.157.1 and 0.160.0 are included
in the declared range but were not individually rerun for this extension.

Codex 0.157.1 also emitted configuration warnings as completed `error`
items before successful turns. These items now remain as status diagnostics
instead of normalized errors. The service already prioritizes a successful
terminal result when determining task completion. Top-level `error` and
`turn.failed` events still normalize as errors. Exiting without a terminal turn
event is also an error, including exit code zero and daemon replay. Hermetic
regressions cover both distinctions.

Reproduce the authenticated checks with an already authenticated CLI:

```bash
codex --version
pnpm server:contracts
pnpm server:contracts:live -- --agent codex --matrix
```

Without `--matrix`, the live command remains a single-turn transport smoke.
The matrix checks actual normalized events, uses temporary working directories,
and consumes account usage. CLI-managed session records remain in the selected
provider home. Optional `PALMAGENT_ADAPTER_SMOKE_EVENTS` writes the latest
scenario's events to a private local diagnostic file; never commit that file.

These results do not establish behavior for untested CLI builds, operating
systems, models/accounts, image inputs, MCP tools, interactive questions, or
terminal handoff. Daemon replay and message delivery retain hermetic contract
coverage; this matrix does not simulate a live dispatcher restart or browser.
Full source verification and packed-install smoke are separate gates.
