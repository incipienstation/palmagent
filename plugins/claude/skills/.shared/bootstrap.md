# Locate and check the Palmagent CLI

Read this reference when an operator skill needs the CLI. The invoking skill owns the
requested operation and its diagnostic exceptions. Handle CLI discovery and bootstrap
internally; never ask the user to install the CLI, run these commands, or edit configuration.

## Reuse authorization and known inputs

An install, reconfiguration, update, or repair request authorizes the corresponding scoped
operation. Carry that authorization across skill handoffs and retries for the same target
and effects; do not ask the same permission again. Inspect current state before retrying a
failed or interrupted operation. A diagnosis, inspection, or preview-only
request authorizes evidence collection, not host changes. Before an unapproved change,
finish the available inspection and present its exact target, command, and impact.

Read existing settings and reuse values already supplied by the user. Ask only for required
values that cannot be determined, or a material choice outside the authorized scope, such
as interrupting active work or deleting data. Explain the planned effects, then run authorized
operations with explicit flags and `--non-interactive` when supported to avoid a second CLI
prompt. Non-interactive mode carries an existing decision; it does not supply missing consent.

## Select the channel and exact command

Before choosing a bootstrap package, read `~/.palmagent/config.json` (or `config.json`
under `PALMAGENT_HOME` when set). Honor an explicitly requested channel; otherwise retain
its saved `channel` or the existing installation's legacy channel. Only a fresh user
with no choice defaults to Stable. Reject malformed JSON, unsupported `schemaVersion`,
or invalid channels rather than guessing or resetting preferences.

Use the installed compatible CLI when available. New installations default to standalone;
Preview is standalone-only. Stable npm installations may continue using npm. A channel
lookup failure never selects another channel or distribution.

For standalone bootstrap, download `https://palmagent.dev/install.sh` to a private temporary
file over HTTPS, following redirects only to HTTPS and rejecting HTTP errors (with curl,
use `--fail --location --proto '=https' --proto-redir '=https'`). Inspect its help, then run
it with the chosen `--channel`. The script checks
Linux x64/arm64, glibc, OpenSSL 3, signed release metadata, and the archive checksum before
running the bundled Node. It needs curl, GNU tar/coreutils, jq and OpenSSL 3; installation
needs no system Node, npm, or compiler. Resolve these prerequisites within the authorized
installation. Do not pipe an error response into a shell.

Pass `--to <exact-version>` when the user selected a release. Use `--prefix <private-absolute-dir>
--print-path` for a temporary diagnostic or migration CLI: this returns the retained command
without replacing the user's CLI link or application service. Retain a custom `--data-dir`
so legacy channel preferences can be read. No settings file is written by bootstrap.
For the first migration from the 0.1.x contract, bootstrap the exact released 0.2.x CLI and
invoke that candidate with `PALMAGENT_CLI_FORWARDED=1`; otherwise an installed older CLI may
receive the command. Confirm its version and help before sending new flags.

For an explicitly selected Stable npm bootstrap, resolve `latest` to one exact stable
version and use `palmagent@<resolved-version>` throughout. Never install a new Preview from
npm or substitute a moving `npx` version after a failure. Old npm prereleases remain
historical artifacts, not a current Preview discovery source.

Keep the selected installation's custom `--data-dir` throughout. Substitute the resolved
internal command for `<cli>` in the invoking skill. Temporary diagnostic or planning
commands must not replace the installed service package.

## Check compatibility before CLI operations

Read the invoking installed plugin's manifest at `../../.claude-plugin/plugin.json` or
`../../.codex-plugin/plugin.json`, relative to that skill directory, then run:

```bash
<cli> compatibility --plugin-version <installed-plugin-version>
```

The CLI and plugin must share the same `x.x.x`, including prereleases. Require exit 0
before the skill's CLI operation. If the command is absent, the manifest is unreadable,
or the check fails, prepare the exact compatible candidate and plugin pair through the
update skill for an authorized migration; otherwise report the mismatch and retain installed state. This check does not update either component; native plugin managers own plugin
installation. Follow the invoking skill's explicit read-only diagnostic exception when
it applies, without treating that exception as permission for host changes.

## Preserve user settings

Read effective settings with `<cli> config get`, retaining a custom `--data-dir`.
This is read-only. Shared settings live outside plugin/package caches and service data,
and survive updates, plugin reinstall, and service removal. Never edit `install.env` to
change channels. For a preference-only request, use the `settings` skill. Initialization
and service changes belong to the requested operation, not to CLI discovery.

## Identify the runtime backend

Read `SUPERVISOR` and `DAEMON_SCOPE` in the selected installation's `install.env`.
`SUPERVISOR=palmagentd` uses the native daemon. New installations persist
`DAEMON_SCOPE=user` and their unit directory; doctor reports the per-installation
`palmagentd-<data-directory-hash>.service` name. Use `systemctl --user` and
`journalctl --user -u <service-name>` for that scope. Missing `DAEMON_SCOPE` retains
the existing system `palmagentd.service`. Host output lives in `<data-dir>/daemon/logs/`.
Absent `SUPERVISOR` retains legacy service diagnostics. The native daemon's
`daemon/current` link selects its retained executable; an existing `daemon/launcher`
is a compatibility alias. CLI control goes directly through the private daemon socket.
Ordinary updates switch the selection without rewriting service registration. Never
restart a provider host or delete retained artifacts to repair the web process.

New daemon installations require systemd 254+, an accessible user manager, account
lingering and writable delegated cgroup v2 with CPU, memory, PID and `cgroup.kill`
support. The CLI enables lingering without an authentication prompt and probes
isolation before registration. If host policy denies it, stop and report the
specific prerequisite; do not add sudo or downgrade isolation. User-service
installation and removal need no sudo; removal preserves shared account lingering.
Ordinary updates retain service scope. Setup migrates legacy system services only
after executions, terminals and routine scripts finish; removing old system
registration needs one-time sudo. Preserve maintenance, migration and retry receipts.
