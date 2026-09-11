---
name: doctor
description: Use when an operator reports a Palmagent instance is unhealthy or wants it checked — phrases like "my dispatcher won't start", "the dispatcher is down / broken / unreachable", "palmagent is failing / crashing / 502 / can't log in", "diagnose the dispatcher", "is my dispatcher healthy?", "check the dispatcher service". Runs structured diagnostics and, on a fault, correlates systemd + journal logs to explain and fix it.
---

# Diagnose a Palmagent instance

Thin wrapper over the `palmagent` CLI's `doctor` subcommand, PLUS adaptive
diagnosis when it reports a fault. The CLI runs the deterministic structured
checks (units active? runner socket present? claude/codex installed + authed?
`nginx -t` clean? TLS expiry? SQLite present? VAPID keys present? port
loopback-only? PWA dist present? disk headroom?) and **exits non-zero on any
failure**. Your added value is correlating its findings with the live logs.

## 1. Locate the CLI

The plugin runs all installation and CLI steps internally; never ask the user to
install the CLI, run these commands, or edit configuration files. Before choosing
a bootstrap package, read `~/.palmagent/config.json` (or `config.json` under
`PALMAGENT_HOME` when set). Honor an explicitly requested channel; otherwise use
its saved `channel` or the existing installation's legacy channel. Only a fresh
user with no choice defaults to Stable. Reject malformed JSON, unsupported `schemaVersion`, or an invalid channel rather
than guessing or resetting preferences. Both agent platforms share this file.

Use the installed CLI when available. If it must be bootstrapped, resolve the
chosen npm tag (`latest` for Stable, `next` for Preview) to one exact version and
use that same version for all bootstrap commands. Do not silently switch channels
or substitute a moving `npx` version after a compatibility failure.

Substitute the resolved internal command for `<cli>` below.

Before invoking an operation, read this installed plugin's version from
`../../.claude-plugin/plugin.json` or `../../.codex-plugin/plugin.json`, relative
to this skill directory, and run:

```bash
<cli> compatibility --plugin-version <installed-plugin-version>
```

Proceed only on exit 0. The CLI and plugin must share the same `x.x.x`, including
alpha, beta, and rc versions. If the command is unavailable, the manifest cannot
be read, or the check fails, stop and explain which released CLI/plugin pair is
needed; do not bypass the check or substitute a moving `npx` version. Plugin
installation is managed separately by Claude Code or Codex. This check does not
update either component.

Stable is the default for new installations. Use Preview only when the operator
opts in; it is available to everyone. If a CLI must be installed, use
`palmagent@latest` for Stable or `palmagent@next` for Preview. A missing Stable
release is not permission to fall back to Preview.

Read effective settings with `<cli> config get` (pass the installation's
`--data-dir` when custom). For an authorized install/setup/update, run
`<cli> config init` with the same data directory to migrate legacy channel settings
before applying service changes. `config get` is read-only. Preserve the user file
across plugin/package refresh, service removal, and reinstall. Never store settings
inside a plugin cache or edit `install.env` to change the channel.

For a preference-only request, use the `settings` skill. It changes the saved
choice without deploying a release or restarting services.

## 2. Run the diagnostics

```bash
<cli> doctor
```

(Namespaced on purpose — this is `palmagent doctor`, never `codex doctor`.)
Show the operator the report.

## 3. If it is all green

Report healthy and stop — no system changes. If they still see a problem, ask
what symptom they observe (e.g. browser error, push not arriving) and dig into
the matching check.

## 4. If the CLI reports a fault — correlate, then propose the fix

For each failing area, gather the live evidence the CLI does not print. The two
systemd units are **`palmagent.service`** (web/SSE server) and
**`palmagent-runner.service`** (long-lived process host). For the relevant
unit(s):

```bash
systemctl status palmagent.service --no-pager
journalctl -u palmagent.service --no-pager -n 50
systemctl status palmagent-runner.service --no-pager
journalctl -u palmagent-runner.service --no-pager -n 50
```

Correlate the doctor finding with the logs and explain the failure in plain terms,
then propose the concrete fix. Common patterns to recognize:

- **Web unit dead / restart-looping** → read the journal stack trace. A
  `better-sqlite3` / native-module error usually means a rebuild is needed
  (`npm rebuild better-sqlite3`); an `EADDRINUSE` means the port is taken; a
  missing-file error often means the PWA dist or data dir moved.
- **Runner socket not answering** while the web unit is up → check the runner
  unit's status/journal; if the runner is down the web server falls back to its
  degraded in-process backend.
- **`claude`/`codex` not found by the service** → the unit's baked `PATH=`
  doesn't resolve the CLI; `journalctl` shows the spawn error. Point at the
  install config's `EXEC_PATH`.
- **`nginx -t` fails or 502/TLS errors** → run `sudo nginx -t` and read
  `journalctl -u nginx --no-pager -n 50`; an expired cert means re-run certbot.
- **Auth/passkey failures** → check that the RP id/origin match the live domain
  (a domain change without `setup` desyncs them).

Always name the **exact remediation command** and confirm with the operator before
running anything that changes the host (restarts, rebuilds, certbot, nginx
reloads). If the fix is a reconfigure, hand off to the `setup` skill; if it is a
version bump, hand off to `update`.
