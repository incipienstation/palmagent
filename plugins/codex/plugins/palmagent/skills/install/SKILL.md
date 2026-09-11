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

Use the saved channel. If the user requests a different one, save it through
`settings` before installation; do not reset a returning Preview user to Stable.

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
