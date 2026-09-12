---
name: settings
description: Use when a user wants to view or change Palmagent preferences, choose Stable or Preview, or enable, disable, or check automatic updates. Manages shared preferences and the update timer; an immediate update is a separate request.
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

## Automatic updates

Automatic updates are off unless the user explicitly enables them. The optional
`autoUpdate` boolean lives in the same user file; absent means false. Describe the
policy before enabling it: check about every six hours, follow the saved channel,
keep the existing `x.x.x` compatibility line and plugins, defer during active,
queued, or waiting tasks, and pause retries after an installation failure.
A new version line needs the `update` skill to coordinate plugin changes.
On Stable, a new patch release also needs that flow. Do not describe this first
automatic-update policy as fully unattended Stable upgrades.

For an existing package installation, use the scheduler API below, retaining its
custom `--data-dir`. Check `<cli> --help` for `auto-update` first; if unsupported,
use `update` to prepare a supporting published release. Enabling requires the
installation owner and non-interactive service-management access.

```bash
<cli> auto-update status
<cli> auto-update enable
<cli> auto-update disable
```

Choose only the action the user requested. `status` is read-only. Enable/disable
configure the background timer and save the preference; never rewrite the JSON
or systemd files directly. Report both the saved setting and actual timer state,
including a failed-update hold. Enabling permits later unattended updates; it
does not prove an update ran. Disabling stops future attempts and lets an already
applying update finish safely. `--dry-run` previews enable/disable without writes.
Service removal stops the timer while retaining the preference for reinstall.

## Errors

On a nonzero exit, stop and explain the failure. Invalid JSON, unsupported schema
versions, and invalid channels must not be replaced with defaults. Use the internal
config API for changes; never rewrite the entire file from a conversation snapshot,
remove unknown settings, or copy user configuration into the plugin distribution.
