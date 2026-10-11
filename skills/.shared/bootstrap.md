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

Use the installed CLI when available. If bootstrap is needed, resolve the chosen npm tag
(`latest` for Stable, `next` for Preview) to one exact published version. Use
`palmagent@<resolved-version>` for every bootstrap command. Moving tags are for discovery,
not the installation target. Never silently switch channels or substitute a moving `npx`
version after failure. Preview requires an explicit choice, is available to everyone, and
is not a fallback when Stable is unavailable.

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
or the check fails, explain the compatible released pair needed and retain installed
state. This check does not update either component; native plugin managers own plugin
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
Absent `SUPERVISOR` retains legacy service diagnostics. Never restart a provider
host or delete retained artifacts to repair the web process.

New daemon installations require systemd 254+, an accessible user manager, account
lingering and writable delegated cgroup v2 with CPU, memory, PID and `cgroup.kill`
support. The CLI enables lingering without an authentication prompt and probes
isolation before registration. If host policy denies it, stop and report the
specific prerequisite; do not add sudo or downgrade isolation. User-service
installation and removal need no sudo; removal preserves shared account lingering.
Ordinary updates retain service scope. Setup migrates legacy system services only
after executions, terminals and routine scripts finish; removing old system
registration needs one-time sudo. Preserve maintenance, migration and retry receipts.
