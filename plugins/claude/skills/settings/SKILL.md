---
name: settings
description: Use when a user wants to view or change Palmagent preferences, choose Stable or Preview, remember a release channel, or check which channel they use. Changes user preferences only; installing or updating a running service is a separate operation.
---

# Palmagent user settings

The user interacts with this plugin. Handle configuration and internal CLI calls
on their behalf; do not ask them to edit a file or run a command.

Settings live at `~/.palmagent/config.json`, shared by the Claude Code and Codex
Palmagent plugins. `PALMAGENT_HOME`, when set by the host, overrides that directory.
The file stays outside plugin/package caches and service data, and must survive
updates, plugin reinstalls, and service removal.

## Read the settings

Locate the internal CLI using the same bootstrap and compatibility procedure as
`install`. Read the shared user file before choosing a bootstrap channel; Stable
is the default only when no preference or existing installation is available.
Honor an explicitly requested channel when bootstrapping; this also lets a new
user opt into Preview before any Stable release is available. Keep bootstrap
commands pinned to the resolved exact version.

```bash
<cli> config get
```

For an existing custom installation, pass its `--data-dir`. The command returns
JSON with `schemaVersion` and `channel`. It is read-only: when the user file is
absent it reports the legacy installation channel or the fresh Stable default.
Explain Stable/Preview in ordinary language rather than showing internal commands.

## Save an explicit preference

For an explicit Preview or Stable request, use `config set` directly. It validates
an existing user file but does not require readable legacy package metadata. Run
the corresponding internal command:

```bash
<cli> config set --channel preview
<cli> config set --channel stable
```

Choose exactly one from the user's request. Do not infer Preview consent from a
plugin prerelease version, developer role, or a newer available release. Everyone
can opt in. A saved choice persists across conversations and both agent platforms.
Report the returned channel. Saving settings does not install, update, downgrade,
or restart a service. If the user also requested an update, continue through `update`.

`config init` creates the file once, migrating the selected installation's legacy
channel when available; an existing user file always wins. Pass the same custom
`--data-dir` to initialization. `config init/set --dry-run` changes nothing.

## Errors

On a nonzero exit, stop and explain the failure. Invalid JSON, unsupported schema
versions, and invalid channels must not be replaced with defaults. Use the internal
config API for changes; never rewrite the entire file from a conversation snapshot,
remove unknown settings, or copy user configuration into the plugin distribution.
