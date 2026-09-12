---
name: install
description: Use when an operator wants to install or set up the Palmagent service on THIS host for the first time — phrases like "install the dispatcher", "set up palmagent on this machine", "first-run setup", "stand up a new dispatcher instance", "deploy the dispatcher to a fresh host". First-run only; for changing an existing install use setup, to diagnose a broken one use doctor.
---

# Install a Palmagent instance

Thin wrapper over the `palmagent` CLI. The CLI does ALL the real work
(preflight, config, systemd units, nginx vhost, certbot TLS, first passkey). Your
job is to locate it, confirm intent, run it, and explain the result. Do **not**
re-implement any setup steps in chat.

## 1. Locate the CLI

Read and follow the [shared CLI bootstrap guidance](../.shared/bootstrap.md).
Use its exact command, saved channel, compatibility check, and custom data directory.

If the user requests a different channel, save it through `settings` before installation;
do not reset a returning Preview user to Stable.

## 2. Confirm intent (this changes the host)

`install` is first-run setup and it touches systemd, nginx, and TLS via `sudo`.
Before running it:

- Confirm this is a **fresh** install (if a service already exists, steer the
  operator to the `setup` skill instead).
- Surface the prerequisites the CLI will preflight, so the operator can fix gaps
  first: Linux + systemd; `node`/`npm`/`git`/`nginx`/`certbot`; `sudo`; and
  at least one of **`claude` or `codex` installed and already logged in**
  (vendor login is interactive and must be done before install). A public **domain with a DNS
  A-record** pointing here and ports **80/443** reachable are required for certbot.
- Ask for the key config values (the CLI prompts in interactive mode, but
  gathering them up front is smoother): domain, internal port (default 4100),
  concurrency (default 8), data dir, repo roots.

To preview without touching anything, run a dry run first and show the rendered
units + nginx vhost:

```bash
<cli> install --dry-run
```

## 3. Run it

For this authorized operation, run `<cli> config init` with the same custom
`--data-dir` before applying service changes. It migrates legacy preferences without
overwriting an existing user file; do not initialize during a dry-run-only request.

Once confirmed:

```bash
<cli> install
```

Run the CLI as the unprivileged account that should own the agent processes.
Never prefix the whole command with `sudo`; Palmagent invokes sudo only for
the systemd, nginx, and certificate operations that need it.

For unattended/CI hosts, pass config via flags/env with `--non-interactive`
(let the CLI define the exact flags; do not invent them — run `<cli> install --help`
if unsure).

## 4. Report

Relay the CLI's summary: what was installed, the enrolled-passkey
`#/enroll/<token>` link the operator must open to register their first passkey,
and the next step. If `install` exits non-zero, read its remediation output and
the preflight failures verbatim, then suggest the exact fix it named (e.g. the
install command for a missing dep, or "log in to claude/codex first"). For a
deeper post-install health check, hand off to the `doctor` skill.
