---
name: update
description: Use when an operator wants to update or upgrade an existing Palmagent install in place to a newer version — phrases like "update the dispatcher", "upgrade palmagent", "pull the latest dispatcher and restart", "bump the dispatcher to the new release". Updates the running instance; not for first-time install (use install) or diagnosing a broken one (use doctor).
---

# Update a Palmagent instance in place

Thin wrapper over the `palmagent` CLI's `update` subcommand. For an npm
package installation, the CLI does the deterministic work: fetch the current
release channel, restart the **web** unit
(which reattaches to in-flight turns), and restart the **runner only when its
own bundled artifact/unit changed** — preserving in-flight agent turns across a normal
update. Do **not** restart units by hand in chat; drive the CLI so that logic is
honored.

## 1. Locate the CLI

```bash
command -v palmagent || echo "use: npx palmagent"
```

Use the global `palmagent` bin if present, else `npx palmagent`.
Substitute it for `<cli>` below.

## 2. Confirm intent and warn about survival

Before running, tell the operator what survives:

- A normal (web-only) update **does NOT kill in-flight agent turns** — the web
  server restarts and reattaches over the runner socket.
- **But** if this update changed the runner's source, the runner restarts and
  in-flight turns die (they recover as `idle(interrupted)`). Say this up front,
  especially if the operator has active tasks running.

## 3. Run it

```bash
<cli> update --pull
```

Source checkouts are maintainer-managed and intentionally reject `--pull`.
Use the repository pnpm verification/build workflow, then run `<cli> setup`.
For a custom install location, pass the same `--data-dir` used at installation.

## 4. Report

Relay the CLI's result: the version now running, whether the runner was
restarted, and the final healthcheck. If `update` exits non-zero, read its
output verbatim. The previous version is not auto-restored, so surface the
failure and hand off to the `doctor` skill for unit and journal correlation.
