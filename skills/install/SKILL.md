---
name: install
description: Use when an operator wants to install or set up the Palmagent service on THIS host for the first time — phrases like "install the dispatcher", "set up palmagent on this machine", "first-run setup", "stand up a new dispatcher instance", "deploy the dispatcher to a fresh host". First-run only; for changing an existing install use setup, to diagnose a broken one use doctor.
---

# Install a Palmagent instance

Thin wrapper over the `palmagent` CLI. The CLI does ALL the real work
(preflight, config, systemd units, nginx vhost, certbot TLS, first passkey). Your
job is to locate it, resolve the installation settings, run it, and explain the result. Do **not**
re-implement any setup steps in chat.

## 1. Locate the CLI

Read and follow the [shared CLI bootstrap guidance](../.shared/bootstrap.md).
Use its exact command, saved channel, compatibility check, and custom data directory.

If the user requests a different channel, save it through `settings` before installation;
do not reset a returning Preview user to Stable.

## 2. Resolve installation settings

`install` is first-run setup and it touches systemd, nginx, and TLS via `sudo`.
Before running it:

- Inspect whether this is a **fresh** install (if a service already exists, steer the
  operator to the `setup` skill instead).
- Surface the prerequisites the CLI will preflight, so the operator can fix gaps
  first: Linux + systemd; `node`/`npm`/`git`/`nginx`/`certbot`; `sudo`; and
  at least one of **`claude` or `codex` installed and already logged in**
  (vendor login is interactive and must be done before install). A public **domain with a DNS
  A-record** pointing here and ports **80/443** reachable are required for certbot.
- Reuse the requested and saved values for domain, internal port (default 4100),
  concurrency (default 8), data dir, and repo roots. Ask only for missing required
  values or unresolved choices under the shared authorization guidance.

To preview without touching anything, run a dry run first and show the rendered
units + nginx vhost:

```bash
<cli> install --dry-run
```

## 3. Run it

For this authorized operation, run `<cli> config init` with the same custom
`--data-dir` before applying service changes. It migrates legacy preferences without
overwriting an existing user file; do not initialize during a dry-run-only request.

Once the required values are resolved and installation is authorized:

```bash
<cli> install --non-interactive <resolved-config-flags>
```

Run the CLI as the unprivileged account that should own the agent processes.
Never prefix the whole command with `sudo`; Palmagent invokes sudo only for
the systemd, nginx, and certificate operations that need it.

Replace `<resolved-config-flags>` with the actual flags for the resolved settings;
read `<cli> install --help` for supported flags. Do not prompt again for an already
authorized installation or silently accept an unresolved configuration choice.

## 4. Report

Relay the CLI's summary: what was installed, the enrolled-passkey
`#/enroll/<token>` link the operator must open to register their first passkey,
and the next step. If `install` exits non-zero, read its remediation output and
the preflight failures verbatim, then suggest the exact fix it named (e.g. the
install command for a missing dep, or "log in to claude/codex first"). For a
deeper post-install health check, hand off to the `doctor` skill.
