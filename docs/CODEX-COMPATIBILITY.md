# Codex compatibility verification

The declared Codex range is `>=0.154.0 <0.161.1`.
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

## Scheduled compatibility maintenance

Maintainers can run the committed maintenance script from a Palmagent **script**
routine. The routine scheduler itself does not invoke an agent. The script checks
npm for new stable Codex releases and processes the oldest unsupported release
through the current `latest` tag, one version per run. It never replaces the
machine's installed Codex CLI.

Use the repository's `.nvmrc` Node version and a working `pnpm`, `npm`, `git`,
`gh`, and `flock` on the routine owner's PATH. GitHub authentication must permit
feature branches and pull requests in the repository. The routine Space must be
this repository, with `develop` as its base. A custom schedule of `0 */6 * * *`
runs every six hours in the scheduler's reported timezone. Script routines use
fresh worktrees without dependencies; the maintenance script installs its own
frozen dependencies and isolates downloaded CLIs.

The script has two explicit modes:

```bash
# Inspect the next release without changing support, opening a PR, or calling a model.
node scripts/codex-compat-routine.mjs --check-only

# Scheduled operation, including one bounded repair only after a confirmed failure.
node scripts/codex-compat-routine.mjs --apply --allow-codex-repair
```

Omit `--allow-codex-repair` to prohibit model calls. The paid path requires the
owner's existing ChatGPT Codex login; it does not provision credentials or use an
API key from the environment. It starts at most one Codex repair process per
target version, with a 15-minute timeout, followed by at most one authenticated
matrix. A failed or interrupted attempt remains held for inspection. Both the
repair and that matrix consume the signed-in account's usage.

The token-free gate checks the actual downloaded executable: generated App
Server schemas for fields Palmagent sends or consumes, supported `exec`/resume
flags, and an isolated App Server `initialize` handshake. It also runs hermetic
server contracts against a known supported baseline and the candidate. Additive
optional fields and unrelated methods do not fail the schema check. Removed
consumed fields, incompatible types, new required request fields, and unknown
constraint changes do. The handshake never starts an inference turn.

Registry, installation, dependency setup, and baseline failures stop before
repair. Candidate execution failures are retried once before escalation.
Passing checks update compatibility metadata, synchronize both plugins, and
record sanitized evidence in `docs/codex-compatibility-runs.json`. A
`schema-contract` record does **not** establish authenticated model behavior,
image handling, MCP integration, or end-to-end session behavior.

A repair may change only the Codex adapters, their contract tests, and the
declarative consumed-protocol specification. It cannot change the comparison
engine, maintenance gate, or workflows. The controller rereads the repaired
specification and verifies the candidate before running the authenticated matrix.
Local promotion checks cover metadata, source safety, types, tooling, server
contracts, and runtime smoke. Browser and packed-install checks run in the full
required CI gate; the scheduled job does not duplicate them on the installation
host. Automatic delivery
uses a version-specific feature PR into `develop`, requires successful exact-head
CI, and respects review requirements and branch protection. Closed/draft PRs,
unexpected file changes, changed PR identity, and unresolved failures remain
held. Stable publication remains a separate release operation.

State, locks, downloaded CLIs, diagnostic logs, and working copies live outside
the repository under the routine owner's XDG state directory. Do not commit
those files. The failure attempt is recorded before Codex starts so an
interrupted run cannot spend again silently. Later schedules resume an existing
PR rather than creating duplicates. If the base advances after an authenticated
repair, review is required; the script does not repeat paid verification.

Palmagent must be running at the scheduled time. Missed runs are skipped; the
next run discovers pending releases again. Set the routine timeout to 3600
seconds, and inspect its recorded output and private diagnostic logs if a job
is held. Retained worktrees and logs are evidence; inspect them before cleanup.
