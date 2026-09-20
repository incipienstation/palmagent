# Palmagent

Palmagent is a self-hosted dispatcher for running Claude Code and Codex from one
agent-neutral interface. The project combines a server, a mobile-first PWA, a public CLI, and
operator plugins for both agent platforms.

This source monorepo contains the shared wire contracts, host runtime, mobile PWA, public CLI
package assembly, and operator plugins.

## Current layout

```text
apps/server/                         Host runtime, CLI installer, SQLite, SSE, and REST
apps/web/                            Mobile-first installable PWA and hermetic UI tests
packages/shared/                     Shared events, task state, permissions, and wire DTOs
skills/                              Canonical operator skill bodies
plugins/claude/                      Claude Code plugin distribution
plugins/codex/                       Codex plugin distribution
scripts/build-pkg.ts                  Self-contained public npm package assembly
.harness/skills/release/              Release workflow, policies, and verification
.claude-plugin/marketplace.json      Claude Code marketplace entry
```

The root package remains private workspace coordination, but its version is the canonical
product version. Internal `@palmagent/*` packages remain private; the build assembles the
unscoped public `palmagent` package under `build/pkg`.

The HTTP layer uses Hono on Node.js. The browser API, passkey authentication,
SSE, and PWA files share one app; local session dispatch uses a separate app on
an owner-only Unix socket. Shared request schemas live in
`@palmagent/shared/requests`; services receive validated values without HTTP
request objects. Routes retain Hono's inferred types and expose validated input
through `c.req.valid()`. The browser uses `hc` with `@palmagent/shared/http`;
server typechecking verifies that the shared REST contract and actual routes agree
on paths, methods, inputs, response bodies, and success statuses. Keep both sides
updated when changing an endpoint. The JSON middleware preserves empty-body and
missing-Content-Type compatibility for existing clients.
Runtime startup and shutdown are separate from app construction.
The runner daemon keeps its existing NDJSON protocol and survives web-server restarts.
The [session lifecycle redesign](docs/SESSION-LIFECYCLE.md) specifies the planned
separation of application updates from agent execution, including the legacy migration and
acceptance gates; it is not yet implemented.

The runtime binds only to a loopback host. A reverse proxy must terminate HTTPS for every
public environment; Palmagent rejects plaintext authentication origins and non-loopback binds.
The operator plugin inspects the host and manages that HTTPS connection. The CLI manages
application services only: it does not require nginx/Certbot or modify proxy/TLS resources.
`palmagent connection` returns the installed origin, loopback upstream, and proxy requirements
as JSON. `doctor` checks the local runtime; the plugin separately verifies public transport.
See [host ingress and migration](docs/HOST-INGRESS.md) for existing installations and removal.

## Choose a release channel

Use the Palmagent plugin in Claude Code or Codex. The plugin handles its internal
CLI installation and commands; users do not need to install or run the CLI directly.

**Stable** is the default for a new user. Ask Palmagent to install the service or
show your settings, and it uses your saved preference on subsequent requests.

<details>
<summary>Try Preview</summary>

Tell the Palmagent plugin: **“Use Preview for Palmagent.”** It saves the preference
and keeps it for future updates. Preview is available to everyone and includes alpha,
beta, and release-candidate versions. Saving this choice does not deploy a release;
ask Palmagent to update when ready. Preview does not grant access to a staging host.

</details>

Both plugins share `~/.palmagent/config.json`. Settings survive new conversations,
plugin/package updates, and service reinstall. The plugin manages this file:

```json
{
  "schemaVersion": 1,
  "channel": "stable"
}
```

Ask Palmagent to return to Stable to change the saved preference. An update that would
downgrade is refused; returning to an older release requires a separately planned rollback.
A missing Stable release never falls back to Preview. See the
[settings and channel policy](.harness/skills/release/references/channels-and-updates.md#npm-channels).

## Plugin skills

The CLI commands below are internal plugin operations.

| Skill | CLI command | Purpose |
| --- | --- | --- |
| `dispatch` | `palmagent session dispatch` | Continue the current local agent session in Palmagent |
| `settings` | `palmagent settings`, `palmagent config`, `palmagent auto-update` | Manage Space search paths, shared preferences, and access-triggered updates |
| `install` | `palmagent install` | Install Palmagent and configure HTTPS and a first passkey |
| `setup` | `palmagent setup`, `palmagent connection` | Reconfigure the application and coordinate host ingress |
| `doctor` | `palmagent doctor`, `palmagent terminal diagnose` | Diagnose the runtime and separately verify public transport |
| `update` | `palmagent update` | Plan and coordinate package/plugin updates, then verify the running version |
| `uninstall` | `palmagent uninstall` | Remove the runtime and clean up verified installation-owned ingress |

Skill bodies are authored once under `skills/` and synchronized to both plugin trees with
`node scripts/sync-skills.mjs`.

## Space search paths

In **Settings → Space search paths**, add or remove folders where Palmagent
should find Git repositories. These are folders on the server, shared across
devices. Changes take effect on the next search without a restart.

The installation owner can manage the same setting locally:

```bash
palmagent settings get
palmagent settings get repo-roots --json
palmagent settings add repo-roots /srv/repos /mnt/projects
palmagent settings remove repo-roots /srv/repos
palmagent settings set repo-roots /mnt/projects --dry-run
palmagent settings set repo-roots
palmagent settings reset repo-roots
```

Use `--data-dir <path>` for the server's custom installation directory.
`set` replaces the complete list; with no paths it disables automatic discovery
without removing registered spaces. `reset` restores `REPO_ROOTS` from
`install.env`, or the server environment for a manual installation. An unset
default disables discovery. Saved settings take precedence over those defaults.
For a manually launched server, run the CLI with the same data directory and
`REPO_ROOTS` environment when inspecting or restoring defaults.

All write commands support `--dry-run`, and `--json` returns effective
`repoRoots`, `defaults`, and `source`. Added paths must be readable directories;
use absolute paths or quote `~/...` to expand the current server owner's home.
Changes are stored privately in `<data-dir>/settings.json`. Run the CLI as the
same user as the server. The web controls require sign-in; they do not change
service configuration or require service-management privileges.

Automatic discovery searches up to four directory levels below each root and
skips hidden folders and nested repositories. Manual Space registration can
still use other paths; folder browsing includes the server user's home and the
configured roots.

## Sessions and working directories

The Tasks screen has a working-directory sidebar on desktop and a directory picker
on mobile. Isolated task worktrees appear as separate directories; selecting a
folder filters every status group and is remembered on that browser.

Open a task's **Resume in shell** panel after its turn finishes. **Release to shell**
pauses Palmagent control and provides a quoted native `codex resume` or `claude --resume`
command with the session ID, directory, provider home, instance binding, and selected model/effort.
Run it on the same host under the service account. The native CLI controls its own
interactive permission prompts. Open only one local writer for a session.

To send an active local session to Palmagent, use the **dispatch** plugin skill.
It registers the exact native session and shows saved messages as a read-only preview
while the CLI stays open. Keep working locally, or close that CLI to continue in Palmagent.
The task remains unavailable for follow-up until that CLI exits and the final
transcript synchronizes. Both directions retain the native session ID and working directory;
Palmagent stores normalized display events and a checked synchronization cursor.
It never copies credentials or rewrites the provider's transcript. Returning tasks
keep their Palmagent permission/model choices; newly imported tasks use Palmagent's
provider defaults. Select the next turn's settings in the task composer.

Transfers currently require Linux, a shared local provider home, and a native JSONL
transcript of at most 64 MiB. Preview waits for unfinished records to be saved.
Missing, rewritten, identity-mismatched, or still-incomplete transcripts after CLI exit
leave the transfer pending with an error. No turn starts automatically
when a transfer completes. Raw native commands cannot prevent another independently
started CLI from opening the same session.

Structured tool image outputs render in both output modes when they contain PNG,
JPEG, WebP, or GIF data (up to 5 MiB each, four images per event). Unsupported formats
remain a text notice. Arbitrary filesystem paths in tool output are not served.

`palmagent compatibility` reports the current agent CLI ranges. The canonical
[agent metadata](packages/shared/src/agent-compatibility.json) is included in both
plugins and the assembled package. These are bounded adapter lanes, checked with
hermetic protocol fixtures; authenticated live provider smoke remains a separate
check. Doctor reports installed CLI versions outside the declared ranges.

## Updates

Ask **“Check for Palmagent updates”** to see the target version and which plugins
need changing. Ask **“Update Palmagent”** to apply that plan. The CLI, server, web
app, and runner ship together; compatible operator plugins can stay installed.

Ask **“Turn on automatic updates”** to install eligible updates discovered when
you open or return to the app. Automatic updates are off by default and follow
your saved Stable/Preview channel. They stay within the current `x.x.x` version
line and keep plugins. On independent-execution installations, running, queued,
or waiting tasks continue through application updates.
A version that needs a plugin change waits for a plugin-assisted update.
With the current compatibility rule, a new Stable patch also needs that flow;
automatic advancement currently applies to prereleases within the same version line.

Ask **“Show my update settings”** to check the preference, pending request, and last result,
or **“Turn off automatic updates”** to stop future attempts. An update already
applying is allowed to finish. Failed installations pause automatic retries until
a successful manual recovery. See the [update policy](.harness/skills/release/references/channels-and-updates.md#coordinated-and-automatic-updates).

In the web app, open **Settings → Updates** to see the running server version,
choose Stable or Preview, toggle automatic updates, and inspect the last check.
The app checks on connection and foreground return, reusing checks made within
15 minutes. **Check again** checks immediately. With automatic updates enabled,
an eligible release installs and the screen switches automatically. When disabled,
**Update** schedules the displayed version. There is no recurring update timer. Existing timers are retired
when the updated package is activated.

Each Palmagent invocation owns a separate execution service, provider connection,
and retained package/runtime. Updates stage a new package, verify compatibility,
and replace the web service while existing processes continue. The browser may
briefly reconnect; this does not restart or resume an agent. Local CLI sessions
remain externally owned. Retained artifacts are not automatically deleted.

Linux package installations also provide persistent Task and Space shells in the
web app and through `palmagent terminal`. Shells have independent service lifetimes,
restore their screen after reconnecting, and retain their starting worktree until
they finish. Everything is distributed through the same `palmagent` npm package.
See [shell access](docs/terminals.md) for controls, installation requirements, and
the platform adapter design.

The first upgrade from a legacy runner installation still waits for its active
work to finish before enabling this architecture. Source installations retain
their idle guard. `--force` never bypasses these protections. Unknown execution
state or an incompatible runtime/storage contract blocks activation.

After the server changes version, the app prepares the new screen and switches
at a quiet moment automatically. Drafts, attachments, open forms, and conversation
position are preserved per tab. An in-flight submission or text composition delays
the switch. **Update** also completes without a second refresh click, even with
automatic installation disabled. If saving the screen fails, the existing page
stays open with a retry option. An outdated app cannot submit changes to a different
server version. This guards the browser/server transition; it does not add package
or SQLite rollback.

These preferences are shared with the CLI and both operator plugins. Saving a
channel does not immediately install a release or downgrade the current version.
Changing settings requires a signed-in session and a package installation whose
owner has non-interactive service-management access. Source builds show their
status without offering host update controls.

## Development

Development and CI use the exact Node.js version in [`.nvmrc`](.nvmrc) and
pnpm 11.5.2 (pinned by `packageManager`). Activate that Node version with your
version manager before installing dependencies. With nvm, install and start the server:

```bash
nvm install
nvm use
pnpm install
pnpm dev
```

The palm geometry lives in `apps/web/src/assets/palm.svg`; the shared light/dark
brand palette lives in `apps/web/src/brand.json`.
After editing either source, run `pnpm --filter @palmagent/web icons:generate` to regenerate
the favicon, PNG icons, and transparent, theme-aware `logo.svg` using the Playwright Chromium
installed for the web tests.

For PWA development, run `pnpm web:dev` in another terminal. See the
[web development guide](apps/web/README.md) for local ports and UI checks.

Run scoped local verification before submitting a change:

```bash
node scripts/verify-local.mjs
```

The command refreshes `origin/develop`, examines the complete task diff including local changes,
and runs the selected metadata, tooling, server, web, and package checks once. Known package
README changes need only metadata checks. Use `--plan` to preview the checks (it still refreshes
the base), or `--base origin/main` to target another branch. An explicit full commit SHA pins
the base instead of fetching. Unknown scope or unavailable history selects all checks.
Reviewed tooling-test-only changes run metadata and type/tooling checks; mixed changes
retain every affected runtime lane. The verifier rejects a Node version that differs
from `.nvmrc` before starting work; `--plan` remains available without switching versions.

Code checks need dependencies installed with `pnpm install --frozen-lockfile`; browser checks
also need `pnpm --filter @palmagent/web exec playwright install chromium`. Detailed logs are
written outside the repository, with a short result per check and a nonzero exit on failure.
The command never commits or ships changes.
Each step has a 10-minute limit (15 minutes for browser checks), configurable with
`--timeout-seconds <seconds>`. A timeout exits with 124; Ctrl-C or SIGTERM cancels the active
check and exits with 130 or 143 respectively. Cancellation targets the check's process group
on POSIX (`taskkill /T` on Windows), with two seconds before forced termination.

Packed verification requires the private `LEAK_DENYLIST`. Without it, the command runs selected
source checks, then stops before packaging with a nonzero exit and reports incomplete verification.
Obtain the trusted PR's packed-check result before delivery. Release candidates continue
to require full source and packed-install verification. See the
[verification skill](.harness/skills/verify/SKILL.md) for delivery requirements.

Individual checks are also available while developing:

```bash
pnpm typecheck
pnpm server:contracts
pnpm server:smoke
pnpm web:verify
pnpm plugins:check
pnpm pkg:check
pnpm release:check
pnpm release:prepare <version>  # preview the version and changelog change
```

The source checks run without a live agent account. With an authenticated CLI, you can additionally
run `pnpm server:contracts:live -- --agent codex`. To check the assembled npm package, run
`pnpm pkg:build` followed by `pnpm pkg:smoke`.

Contribute through a `feature/*` branch from `develop` and a pull request targeting `develop`.
Keep private environment details out of source and examples. [AGENTS.md](AGENTS.md) contains
the instructions for coding agents working in this repository.

For releases, follow the [release skill](.harness/skills/release/SKILL.md), which covers versioning, candidate
artifacts, automatic Preview publication for product changes on `develop`, and the single Stable
publication approval. Repository visibility and host deployment remain separate decisions.

## Install the operator plugin

Choose a **published** plugin tag with the same `x.x.x` as `palmagent --version`.
Replace `<version>` below with that version. Use a stable tag for Stable and an
explicit prerelease tag for Preview; marketplace refs are independent of npm tags.

### Claude Code

```text
/plugin marketplace add https://github.com/incipienstation/palmagent.git#v<version>
/plugin install palmagent@palmagent
```

### Codex

```bash
git clone --depth 1 --branch 'v<version>' https://github.com/incipienstation/palmagent.git '/abs/path/to/palmagent-v<version>'
codex plugin marketplace add '/abs/path/to/palmagent-v<version>/plugins/codex'
codex plugin add palmagent@palmagent
```

Replace the checkout path with an unused absolute directory and retain it as the local
marketplace source. Codex needs the nested `plugins/codex` marketplace root;
`--sparse plugins/codex` does not make that directory the root of a Git marketplace.
See [plugins/codex/README.md](plugins/codex/README.md) for Codex-specific details.

## License

[MIT](LICENSE)

Maintainers deploy exact npm versions or tested CI packages with the [staging runbook](docs/STAGING.md).
