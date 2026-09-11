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

The shared user channel is preserved. An explicit request to change the preference
is handled through `settings` before updating; never select Preview just because
it has a newer version. Saving a preference does not mean a release was deployed.
For an exact release, add `--to <version>` with `--pull`. Downgrades are refused.
Use `--dry-run` to inspect the plan; it does not resolve registry versions.

After the update, repeat the plugin compatibility check with the same plugin
version. If the CLI crossed an `x.x.x` boundary, report that a matching plugin
release must be installed before another plugin operation. CLI and plugin updates
are not yet one transaction; never report both as updated from CLI success alone.

Source checkouts are maintainer-managed and intentionally reject `--pull`.
Use the repository pnpm verification/build workflow, then run `<cli> setup`.
For a custom install location, pass the same `--data-dir` used at installation.

## 4. Report

Relay the CLI's result: the version now running, whether the runner was
restarted, and the final healthcheck. If `update` exits non-zero, read its
output verbatim. The previous version is not auto-restored, so surface the
failure and hand off to the `doctor` skill for unit and journal correlation.
