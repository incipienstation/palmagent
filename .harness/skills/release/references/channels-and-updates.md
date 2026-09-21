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
channel override is saved only after health succeeds. Independent application
activation attempts to restore its previous retained release after failure; legacy
package replacement has no automatic rollback. No database rollback occurs.

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
2. The CLI discovers installed native plugins and refreshes older compatible
   versions using the exact published Git tag, retaining previous source/scope
   details in a private recovery receipt. The skill handles older CLIs. It verifies
   actual installed manifests before proceeding. A catalog refresh is insufficient.
3. `update --pull --to <planned-version> --plugin-manifest <verified-path>` checks
   target compatibility before activation. Independent installations stage a new
   npm prefix and retain existing artifacts. Legacy replacement verifies ownership
   of the global prefix. Activation checks the exact `/api/health` version.

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
`autoUpdate: true` in the shared user file; an absent value means off. Enabling
requires an installed package, its owner, and non-interactive service-management
access. Signed-in app connection and foreground return check the saved channel.
Ordinary access reuses a 15-minute result; **Check again** bypasses the cache.
Time passing never triggers a check. Existing recurring timers are removed on
package activation and update-setting changes.

**Update** pins the displayed version in `update-access.json`. Automatic access
checks can request eligible updates when enabled; changing channel only checks
availability and cancels a request in the former channel. Active-task completion
resumes a pending request. The one-shot systemd executor reads that durable request
and rechecks authorization, channel, compatibility, and execution isolation under
the host lock (legacy installations also require idle). It survives a web-server restart and never chooses a different release
because the npm tag moved. Native file events notify connected Settings screens
of request/result changes without status polling.

After deployment, each visible browser tab waits for a fully installed service
worker and a quiet moment, checkpoints its local state, and reloads automatically.
Manual **Update** uses this same completion path without another confirmation.
Browser submissions, image preparation, passkey prompts, and text composition
block the transition. A failed checkpoint keeps the page open for recovery.
Browser event streams briefly reconnect around worker activation; no agent
lifecycle action is sent. Hidden and offline tabs wait until they return.

Automatic updates refresh older compatible plugins and stay within the current
package's `x.x.x`. A plugin-only update is eligible even when the app is current.
An equal or newer compatible plugin is retained without downgrading. Native
managers preserve installation scope; managed installations are never converted
to user installations. Disabled Codex plugins need operator handling because its
install command enables them. Failed native updates pause automatic retries and
retain `<data-dir>/plugin-update.json`; catalog restoration is not plugin rollback.
They defer a new compatibility line, including any new Stable patch release, to
the update skill. Unattended advancement therefore applies to prereleases within
one version line under the current compatibility promise. Before package mutation,
the updater opens a maintenance window that temporarily rejects new task starts
and follow-ups and defers routine dispatch. The server acknowledges the window;
independent installations then verify the execution protocol and retained release
contracts, including application API and product storage compatibility. Each
invocation retains its package tree, pinned Node runtime, provider adapter, and
service cgroup. Activation restarts only the web service. Active, queued, and
waiting independent invocations do not block application updates.

Legacy installations instead check SQLite and the runner for active work before
the first migration. Manual legacy replacement, direct activation, and source
`setup` retain this barrier; `--force` cannot bypass it. No live process is adopted
into a new host or silently resumed. Unknown legacy activity defers the operation.
Maintenance ownership includes process start and boot identity so a crashed
updater does not leave admissions disabled. Source development may explicitly use
an in-process backend; failure to reach a configured daemon no longer selects it.

A shared OS lock serializes package updates, install/setup, service removal, and
update preference and request changes for the user configuration home. `update-result.json` in the
installation data directory records the previous/target versions and result. An
installation/activation failure or interrupted attempt pauses automatic retries;
`doctor` and `auto-update status` expose the hold. A successful manual update or
repair clears it. An exact same-version retry can repair a recorded failed attempt.
Independent activation records its previous and target configuration and attempts
to restore the previous application on failure. The activation receipt records
whether health was restored or operator recovery is required. Execution hosts
are never restarted as rollback. Retain all artifacts and inspect live identity;
legacy package replacement and databases are not automatically restored.

Disabling prevents future attempts without killing an update mid-install. Service
removal removes legacy timers while preserving user preferences. These source
capabilities do not deploy an update on a host merely because their PR is merged.

Published versions are immutable. Never overwrite or reuse a version. If a
release is bad, move the dist-tag back to the last good version, deprecate the
bad version with a useful message, and publish a new patch or prerelease.
