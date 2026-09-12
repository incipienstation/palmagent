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

## 1. Inspect without changing the installation

Read the [shared CLI bootstrap guidance](../.shared/bootstrap.md) for discovery and
channel selection. Before applying its compatibility gate, gather read-only evidence:
installed package and plugin versions, runtime health, service state, journals, and
`auto-update status` when the installed CLI supports it. A mismatch must not block those
checks. Preserve invalid settings for diagnosis; never replace packages, initialize
configuration, or erase update results just to make diagnostics run.

Use a temporary exact compatible CLI if needed for `doctor`. If no compatible command
is available, continue the file, health, and journal inspection and report why the CLI
check could not run. This exception permits evidence collection, not host changes.

## 2. Run the diagnostics

Apply the shared compatibility check before invoking `doctor`. After an update failure,
a `failed` or unfinished `applying` result keeps automatic retries paused even when
other health checks are green.

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
- **Automatic updates paused** → inspect the last update result and the update
  service journal. Determine the actual installed and running package versions
  before restoring a plugin or retrying the exact release through `update`.
  Package replacement does not restore a database; plan downgrades separately.

Always name the **exact remediation command** and confirm with the operator before
running anything that changes the host (restarts, rebuilds, certbot, nginx
reloads). If the fix is a reconfigure, hand off to the `setup` skill; if it is a
version bump, hand off to `update`.
