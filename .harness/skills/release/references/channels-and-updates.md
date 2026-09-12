# Channels and updates

## npm channels

Prereleases publish only to the `next` dist-tag. Stable releases publish to
`latest`.

| Version | npm tag | Install command |
| --- | --- | --- |
| `0.1.0-alpha.1`, `beta`, or `rc` | `next` | `npm install -g palmagent@next` |
| `0.1.0` and later stable versions | `latest` | `npm install -g palmagent` |

Users see **Stable** (`latest`, default) and **Preview** (`next`, explicit opt-in).
Preview is available to everyone; developer status is not an access rule. Staging
is an environment role, not a public release channel or permission to access a host.

The plugin is the user interface and owns CLI bootstrap and invocation. Users ask it
to install, update, or change settings; they do not need to run these commands themselves.

### Shared user settings

Both plugins read `~/.palmagent/config.json` with `schemaVersion: 1` and `channel`
(`stable` or `preview`). This is the channel's single source of truth. The host may
set an absolute `PALMAGENT_HOME` directory for isolation; agent-specific plugin caches
and service data directories do not determine the user settings location.

The internal `config get` command is read-only. When the file is missing, it reads
`RELEASE_CHANNEL` from the selected installation's `install.env`; older package installs
without that key infer their channel from package metadata. A fresh user defaults to Stable.
Pass the same `--data-dir` for an existing custom installation to locate migration input.

`config init` persists that result once and never overwrites an existing user file.
Install/setup initialize settings before saving service configuration; successful updates
also initialize settings when needed. Service configuration saves no longer write
`RELEASE_CHANNEL`. A leftover legacy key is ignored whenever the user file exists and
is removed on the next service configuration save. Migration leaves other installation
values intact. Package versions never override a migrated preference.

The `settings` skill uses `config set --channel stable|preview` for an explicit preference
change. It works before a service is installed and does not deploy or restart anything.
The preference remains saved even if a later, separately requested deployment fails.
The existing operation-level `--channel` override is still supported: install/setup save
it with configuration, and update saves it only after health succeeds.

Config writes validate known fields, preserve unrelated fields, and atomically replace
the file. New directories are private (0700), and written files are owner-only (0600).
Invalid JSON, unknown schema versions, or invalid channel values fail without resetting
the file. `config get` and `config init/set --dry-run` never write settings. Config files
are outside plugin/package caches and survive service removal and reinstall.

The following commands describe the internal execution interface:

For coordinated manual pulls, also pass `--plugin-manifest <path>` for each
participating installed plugin; the channel and target examples below omit that
repeated argument for readability.

- `palmagent update --pull --plugin-manifest <installed-plugin.json>` follows the saved channel.
- `palmagent update --pull --channel preview` opts into Preview.
- `palmagent update --pull --channel stable` returns to Stable when it can advance
  or retain the installed version. An older Stable target is refused.
- `palmagent update --pull --to <exact-version>` selects one release within the
  chosen channel policy without changing the saved channel. It does not create a
  permanent version pin. Stable rejects prereleases; all downgrades are refused.
- `--dry-run` shows the intended channel/spec without writing config or contacting
  npm. A real pull resolves and validates one exact version before installing it.

Registry errors and missing tags fail without switching channels. An update's explicit
channel override is saved only after health succeeds; package or restart failure is not
rolled back automatically. Returning to an older version requires a separate database-aware rollback.

### CLI and operator plugin compatibility

Release artifacts still share one product version. Independently installed CLI and
plugin copies can differ within that version's `x.x.x`: for example, a `0.1.0-alpha.2`
plugin can pair with `0.1.0-beta.1`, `0.1.0-rc.1`, or `0.1.0`, but not `0.1.1` or `0.2.0`.
This is Palmagent's CLI contract promise, including prereleases; it is not a general
SemVer guarantee. Changes that break operator commands must move to a new base version.

`palmagent compatibility --plugin-version <version>` checks this mapping without
loading host configuration or changing anything. Operator skills read their own installed
manifest and require a successful check before invoking host operations. Older CLIs
without this command require an explicitly chosen compatible release before these skills
can run. The CLI remains the internal execution layer for plugin operations.

npm dist-tags do not select plugin marketplace refs. Install a plugin from a published
`v<version>` tag in the same base version, using the platform's marketplace ref support.
A moving `main`/`develop` marketplace can include unpublished changes and is intended for
maintainer source testing. Plugin managers control refresh/caching separately, so a CLI
update is not evidence of a plugin update. The coordinated update skill uses native
manager operations and verifies installed manifests separately from runtime health.

### Coordinated and automatic updates

The package is one update unit containing the CLI, server, PWA, and runner. The
`update` plugin coordinates it with participating Claude Code and Codex plugins:

1. `update --plan --plugin-manifest <path>` resolves a single exact npm target and
   returns JSON with the package action and each plugin's keep/update decision.
   Repeat the manifest argument for each participating installation and scope.
   Planning is read-only; unlike `--dry-run`, it contacts npm.
2. If a plugin needs changing, the agent uses its native manager and the exact
   published Git tag, retaining the previous ref/scope for recovery. It verifies
   actual installed manifests before proceeding. A catalog refresh is insufficient.
3. `update --pull --to <planned-version> --plugin-manifest <verified-path>` checks
   target compatibility before replacing the package. The active npm prefix must
   own the installed package. It invokes the installed target CLI directly and
  verifies that `/api/health` reports the intended package version.

Legacy plugins can still call `update --pull` without manifest arguments within
the current `x.x.x`; crossing that line requires the manifest-based flow. This
keeps existing plugin commands compatible within the promised version line.

Skills check CLI help for the new planning flags before using them. Older CLIs
may ignore unknown flags; use a temporary exact released CLI that supports the
interface, never send these flags to a legacy updater. A current package can
still need a plugin repair. A compatible package already at the target is checked
for runtime health and retained.

This coordinates a single user request; it is not an atomic transaction across
independent plugin managers, npm, systemd, and SQLite. A plugin may need a native
reload or a new agent session before its new skills become active.

The settings skill exposes `auto-update enable|disable|status`. Enabling stores
`autoUpdate: true` in the shared user file and activates the systemd update timer;
an absent value means off. Enabling requires an installed package, its owner, and
non-interactive service-management access. The timer invokes the same updater
with `--pull --automatic`, about every six hours with jitter, under that owner
and the installation's saved PATH, data directory, and user configuration home.

Automatic updates retain plugins and stay within the current package's `x.x.x`.
They defer a new compatibility line, including any new Stable patch release, to
the update skill. Unattended advancement therefore applies to prereleases within
one version line under the current compatibility promise. Before package mutation,
the updater opens a maintenance window that temporarily rejects new task starts
and follow-ups and defers routine dispatch. The server acknowledges the window;
the updater then checks SQLite and the runner for active, queued, or waiting work.
Busy or unverifiable state defers the update and releases the window. This avoids
an idle-check/start race and also protects an in-process fallback backend. A
crashed updater does not leave admissions disabled: maintenance ownership includes
the process start identity and boot identity, so PID reuse is not mistaken for a
live update. Older servers without maintenance support defer automatic updates.

A shared OS lock serializes package updates, install/setup, service removal, and
scheduler changes for the user configuration home. `update-result.json` in the
installation data directory records the previous/target versions and result. An
installation/activation failure or interrupted attempt pauses automatic retries;
`doctor` and `auto-update status` expose the hold. A successful manual update or
repair clears it. An exact same-version retry can repair a recorded failed attempt.
No package or database is automatically restored. Inspect actual package/runtime
identity after failure and plan any downgrade with database compatibility in mind.

Disabling prevents future attempts without killing an update mid-install. Service
removal stops and removes the timer while preserving user preferences; reinstall
or setup restores a previously enabled timer only after service health succeeds.
These source capabilities do not enable a timer or deploy an update on a host
merely because their PR is merged.

Published versions are immutable. Never overwrite or reuse a version. If a
release is bad, move the dist-tag back to the last good version, deprecate the
bad version with a useful message, and publish a new patch or prerelease.
