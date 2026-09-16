---
name: settings
description: Use when a user wants to view or change Palmagent preferences or Space search paths, choose Stable or Preview, or enable, disable, or check automatic updates. Manages shared preferences and access-triggered updates; an immediate update is a separate request.
---

# Palmagent user settings

The user interacts with this plugin. Handle configuration and internal CLI calls
on their behalf; do not ask them to edit a file or run a command.

Channel and update preferences live at `~/.palmagent/config.json`, shared by the Claude Code and Codex
Palmagent plugins. `PALMAGENT_HOME`, when set by the host, overrides that directory.
The file stays outside plugin/package caches and service data, and must survive
updates, plugin reinstalls, and service removal.

## Read the settings

Follow the [shared CLI bootstrap guidance](../.shared/bootstrap.md) for discovery,
channel selection, exact-version bootstrap, and compatibility. An explicit Preview
request also applies during bootstrap when no Stable release is available.

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
policy before enabling it: check when the signed-in app connects or returns to the foreground, follow the saved channel,
keep the existing `x.x.x` compatibility line and plugins, preserve active runs,
and pause retries after an installation failure. Independent execution hosts
continue through updates; the first legacy migration waits for idle.
A new version line needs the `update` skill to coordinate plugin changes.
On Stable, a new patch release also needs that flow. Do not describe this first
automatic-update policy as fully unattended Stable upgrades.

For an existing package installation, use the preference API below, retaining its
custom `--data-dir`. Check `<cli> --help` for `auto-update` first; if unsupported,
use `update` to prepare a supporting published release. Enabling requires the
installation owner and non-interactive service-management access.

```bash
<cli> auto-update status
<cli> auto-update enable
<cli> auto-update disable
```

Choose only the action the user requested. `status` is read-only. Enable/disable
save the preference and retire any legacy recurring timer; never rewrite the JSON
or systemd files directly. Report the saved setting, pending request, and last result,
including a failed-update hold. Enabling permits later unattended updates; it
does not prove an update ran. Disabling stops future attempts and lets an already
applying update finish safely. `--dry-run` previews enable/disable without writes.
Service removal removes the update executor while retaining the preference for reinstall.

Settings in the signed-in app offer **Check again**, and **Update** when automatic
updates are disabled. Enabled automatic updates need no additional update click. Checks reuse a
15-minute result on ordinary access; explicit checks bypass that cache. Elapsed
time alone never triggers a check. An explicit Update pins the displayed version
and activates independently of running execution hosts. Legacy installations
wait for active tasks to finish; completion resumes their pending requests. Changing channel
cancels the old request and checks the new channel without immediately installing.

## Space search paths

For repository discovery, use the public `settings` CLI as the installation owner.
Keep the server's custom `--data-dir`; these settings belong to that installation,
in `<data-dir>/settings.json`, and are shared with **Settings → Space search paths**.
Check `<cli> settings --help` before use on older installations.

```bash
<cli> settings get repo-roots --json
<cli> settings add repo-roots /srv/repos
<cli> settings remove repo-roots /srv/repos
<cli> settings set repo-roots /mnt/projects
<cli> settings reset repo-roots
```

Use only the requested action. `set` replaces the full list; with no paths it
disables automatic discovery while keeping registered spaces. `reset` restores
the installation's `REPO_ROOTS` defaults. Added paths must be readable directories
and use absolute paths or quoted `~/...`. Changes apply on the next search
without a restart. `--dry-run` validates and previews without writing;
`--json` reports effective paths, defaults, and source. For manual servers,
use the same data directory and `REPO_ROOTS` environment as the server.
Never rewrite the settings file directly.

## Errors

On a nonzero exit, stop and explain the failure. Invalid JSON, unsupported schema
versions, and invalid channels must not be replaced with defaults. Use the internal
config API for channel preferences and the settings CLI for search paths; never rewrite the entire file from a conversation snapshot,
remove unknown settings, or copy user configuration into the plugin distribution.
