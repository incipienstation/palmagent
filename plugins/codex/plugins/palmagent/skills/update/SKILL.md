---
name: update
description: Use when a user wants to update Palmagent, check for updates, preview an update plan, or recover a failed update. Coordinates the package and participating operator plugins; automatic update preferences belong to settings.
---

# Update Palmagent

The user interacts with this plugin. Handle discovery, internal CLI calls, and
native plugin-manager operations on their behalf. Never ask them to install or
run the CLI, edit configuration, or manually restart services.

## 1. Inspect and plan

Read and follow the [shared CLI bootstrap guidance](../.shared/bootstrap.md).
Honor an explicit channel request through `settings` and preserve the installation's
custom `--data-dir` throughout. Check `<cli> --help` for `--plan` and `--plugin-manifest`
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

Compatibility permits updating; it does not mean a plugin is current. Refresh
older participating plugins to the planned published release even when the app
is already current. Retain an equal or newer compatible plugin; never downgrade
it merely to match the app.

A plan with `pluginManagement: "native"` lets the CLI discover installed Codex and
Claude plugins and refresh them through their native managers during apply. Use
that path without separately repinning catalogs. It retains exact released
marketplace checkouts, preserves scopes, verifies installed manifests, and records
recovery details in `<data-dir>/plugin-update.json`. Managed installations stay
managed. Disabled Codex plugins require native operator handling because its
install command enables them; do not silently change that preference.

For an older CLI without native plugin management, refresh older plugins yourself
before package activation, even if its compatibility-only planner says `keep`:

- Claude Code: repin the dedicated Palmagent marketplace to the exact published
  Git URL `https://github.com/incipienstation/palmagent.git#v<targetVersion>` and
  update `palmagent@palmagent` in each original scope.
- Codex: clone that repository's exact `v<targetVersion>` tag into a new, retained
  operator-owned directory. Verify the tag and plugin manifest, register its
  absolute `plugins/codex` path, and use `codex plugin add palmagent@palmagent`.
  Keep the checkout as its source. The repository root is not a Codex marketplace.

Read native help before mutation and record the old source/ref, installed version,
scope, and enabled state. Replace registrations only for the dedicated Palmagent
marketplace; preserve unrelated plugins and marketplaces. Verify the resulting
source and installed manifest, not just the catalog or command exit code. If a
manager or policy cannot preserve scope/state, report the concrete limitation;
do not bypass policy or report a complete update.

Keep the same exact package target throughout. On partial failure, inspect native
inventories and the recovery receipt. Already updated compatible plugins can stay;
restore a failed catalog registration through its native manager using the recorded
source. Do not claim that restoring a catalog rolled back installed plugin files.

## 3. Apply and verify

Read [host ingress](../.shared/ingress.md) when adopting an older installation or verifying
public access. The new CLI preserves existing proxy/TLS resources on update. Record
existing routes and renewal ownership without rewriting healthy configuration; after
activation compare `<cli> connection` with the route and verify HTTPS separately.


Preserve every running Codex and Claude session. Independent-execution package
installations stage an exact release, retain the previous artifacts, and restart
only the web service. Existing invocation hosts keep their provider connection,
process, release, and runtime. A web reconnect never resumes an agent.

The first migration from a legacy runner and source-update `setup` still require
an idle maintenance window. Active or unverifiable legacy work defers the update,
including manual calls and `--force`. Let it finish naturally; never stop sessions
to make an update proceed. Drive the CLI service logic, not manual unit restarts.

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
runtime/package identity and logs. Do not erase the failure record to resume automatic
attempts. Independent activation attempts to restore the previous application release;
verify the activation receipt and live health before claiming recovery. Legacy
package replacement has no automatic rollback. No database rollback occurs.
Restore a prior plugin only after verifying which package is actually installed
and running; a partial package failure is not evidence that the old pair remains
intact. Plan any package downgrade and database recovery separately.

Automatic updates reuse this planner and native plugin refresh flow. They run only
when explicitly enabled, stay within the installed package's `x.x.x`, and refresh
older compatible plugins, including when only plugins need updating. They defer
when the package or a participating plugin crosses a compatibility boundary.
Independent runs do not block application updates; legacy runs block migration. `settings` controls access-triggered updates. Source checkouts remain
maintainer-managed and use the repository build workflow followed by `setup`.
