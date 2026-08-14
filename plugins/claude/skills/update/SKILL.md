---
name: update
description: Use when an operator wants to update or upgrade an existing Palmagent install in place to a newer version — phrases like "update the dispatcher", "upgrade palmagent", "pull the latest dispatcher and restart", "bump the dispatcher to the new release". Updates the running instance; not for first-time install (use install) or diagnosing a broken one (use doctor).
---

# Update a Palmagent instance in place

Thin wrapper over the `palmagent` CLI's `update` subcommand. The CLI does
the deterministic work: fetch the new version, rebuild, restart the **web** unit
(which reattaches to in-flight turns), and restart the **runner only when its
own source/unit changed** — preserving in-flight agent turns across a normal
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
<cli> update
```

The CLI self-detaches if it is invoked from inside a dispatcher cgroup (so a
runner restart can't kill the update mid-flight) — that is expected; follow its
printed log pointer for progress.

## 4. Report

Relay the CLI's result: the version now running, whether the runner was
restarted, and the final healthcheck. If `update` exits non-zero, read its
output verbatim — the CLI prints recent journal lines on a failed healthcheck;
the previous version is not auto-restored, so surface the failure and, if the
operator wants a closer look, hand off to the `doctor` skill.
