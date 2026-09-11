---
name: setup
description: Use when an operator wants to reconfigure or change the settings of an EXISTING Palmagent install on this host — phrases like "change the dispatcher domain", "reconfigure palmagent", "update the repo roots / port / concurrency", or "re-render the systemd units or nginx vhost". Not for moving persistent data, first-time install (use install), or diagnosing a broken instance (use doctor).
---

# Reconfigure an existing Palmagent instance

Thin wrapper over the `palmagent` CLI's `setup` subcommand. The CLI owns
the deterministic work — re-rendering the systemd units + nginx vhost from the
new config and re-running certbot if the domain changed. Do **not** edit unit
files or nginx config by hand in chat; drive the CLI.

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

## 2. Confirm what is changing

`setup` is idempotent but it re-renders host config and may restart the service.
Before running:

- Ask which values change (domain, internal port, concurrency, repo roots).
  `--data-dir` locates an existing custom installation; it does not move data.
  Note that **changing the domain re-runs certbot** and requires the new
  domain's DNS A-record + ports 80/443 to be live first.
- Warn that re-rendering may restart the web unit; in-flight agent turns reattach
  on a web-only restart. A runner unit/artifact change restarts the runner and
  interrupts active turns; a domain/auth change is operator-visible.

To preview the re-rendered units + nginx vhost without applying:

```bash
<cli> setup --dry-run
```

## 3. Run it

```bash
<cli> setup
```

For unattended use, pass the changed values as flags/env with `--non-interactive`
(check `<cli> setup --help` for the exact flags rather than guessing).

## 4. Report

Relay the CLI's summary of what was re-rendered and whether certbot ran. If it
exits non-zero, read its remediation output verbatim and propose the named fix.
If the operator instead reports the instance is now broken, hand off to the
`doctor` skill.
