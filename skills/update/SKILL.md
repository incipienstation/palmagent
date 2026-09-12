---
name: update
description: Use when a user wants to update Palmagent, check for updates, preview an update plan, or recover a failed update. Coordinates the package and participating operator plugins; automatic update preferences belong to settings.
---

# Update Palmagent

The user interacts with this plugin. Handle discovery, internal CLI calls, and
native plugin-manager operations on their behalf. Never ask them to install or
run the CLI, edit configuration, or manually restart services.

## 1. Inspect and plan

Read `~/.palmagent/config.json` (`PALMAGENT_HOME/config.json` when overridden).
Honor an explicit channel request through `settings`; otherwise retain the saved
channel, legacy installation channel, or Stable for a fresh user. Never infer
Preview consent or fall back to it when Stable is unavailable.

Locate the installed CLI as in `install`, preserving the installation's custom
`--data-dir` throughout. Check `<cli> --help` for `--plan` and `--plugin-manifest`
before using them: older CLIs may ignore unknown flags. If absent, bootstrap an
exact published CLI release compatible with this plugin into a temporary command,
without replacing the installed service package, and check its help again. Stop
if no published release supports this interface. Never send new update flags to
an older CLI or switch to a moving `npx` version.

Inspect the current platform's installed Palmagent manifest, plus participating
Palmagent installations in the other available platform and scopes, using their
native inventories. Pass each actual installed manifest path, not an assumed
version from a marketplace catalog. Managed installations must remain managed.
The manifest relative to this skill is `../../.claude-plugin/plugin.json` or
`../../.codex-plugin/plugin.json`.

```bash
<cli> update --plan --plugin-manifest <installed-manifest>
```

Repeat `--plugin-manifest` for each participating plugin. Add `--to <version>`
only for an explicitly requested exact release. Planning contacts npm, returns
JSON, and changes no package, preferences, services, or plugin state.

Explain the current and target package versions and which plugins can stay or
need updating. The package includes the CLI, server, web app, and runner. A plan
with `packageAction: keep` may still need a plugin repair. A request only to check
or plan stops here. An update request authorizes the resulting update flow; do
not ask the same permission again.

## 2. Prepare required plugins

Keep every plugin whose plan action is `keep`. For `update`, use the exact
published `v<targetVersion>` marketplace ref and the platform's native manager:

- Claude Code: the Palmagent Git marketplace URL accepts `#v<targetVersion>`;
  install/update `palmagent@palmagent` in the original scope.
- Codex: clone `https://github.com/incipienstation/palmagent.git` at the exact
  `v<targetVersion>` tag into a new, retained operator-owned directory. Verify the
  checkout ref and `plugins/codex/plugins/palmagent/.codex-plugin/plugin.json`.
  Register its absolute `plugins/codex` path with `codex plugin marketplace add`,
  then install with `codex plugin add palmagent@palmagent`. The repository root
  has no Codex catalog; `--sparse plugins/codex` does not relocate the marketplace
  root. Keep the checkout as the local source; native marketplace upgrade does
  not advance it. Prepare a separate checkout for each target version.

Read native command help before mutation. Save the original source/ref, scope,
and plugin version for recovery. Verify the target ref and manifest before
changing the existing registration. Re-adding an already registered marketplace
may retain its old ref; inspect the resulting source, not just the exit code.
If repinning requires native remove/add, use that flow only for the dedicated
Palmagent marketplace after confirming it contains only Palmagent. Preserve all
other marketplaces and plugins. If policy, scope, or manager capabilities prevent
a precise replacement, stop before changing the service package.

Read the newly installed manifests and verify they match the plan's required
versions. A refreshed catalog alone is not an installed-plugin update. Keep the
same package target throughout; do not resolve a newer moving tag midway.
If plugin preparation fails, restore any changed Palmagent registrations through
the native managers using the recorded prior refs and report what was restored.

## 3. Apply and verify

Explain that a web restart preserves runner-owned turns, but a changed runner
requires a restart that ends active turns. If active work would be interrupted,
defer until it finishes unless the user has explicitly accepted interruption.
Drive the CLI's service logic; do not restart units yourself.

```bash
<cli> update --pull --to <planned-target> --plugin-manifest <verified-installed-manifest>
```

Repeat the verified manifest argument for all participating plugins. The CLI
rechecks target compatibility before package replacement, installs the exact
version, activates it through the new CLI, verifies the runtime version and
health, and checks plugin manifests again. Incompatible targets stop before
package mutation. This flow also repairs a known failed attempt at the same
version; successful recovery releases the automatic-update hold.

Report the actual package version, retained/updated plugin versions, runtime
health, and whether plugin activation is still pending in the current agent
session. Use the native reload mechanism when available; if a new session is
required, say so rather than claiming its loaded skills changed already.

## 4. Failure and automatic updates

An installation or activation failure records the previous/target versions and
pauses automatic retries. Inspect `auto-update status` and use `doctor` for
runtime/package identity and logs. Do not erase the failure record to resume a
timer. Do not claim package or database rollback: no automatic rollback occurs.
Restore a prior plugin only after verifying which package is actually installed
and running; a partial package failure is not evidence that the old pair remains
intact. Plan any package downgrade and database recovery separately.

Automatic updates reuse this package planner and activation flow. They run only
when explicitly enabled, stay within the installed package's `x.x.x`, retain
plugins, and defer when a new compatibility line or active/queued/waiting tasks
require user attention. `settings` controls the timer. Source checkouts remain
maintainer-managed and use the repository build workflow followed by `setup`.
