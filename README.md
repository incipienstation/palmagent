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
request objects. Runtime startup and shutdown are separate from app construction.
The runner daemon keeps its existing NDJSON protocol and survives web-server restarts.

The runtime binds only to a loopback host. A reverse proxy must terminate HTTPS for every
public environment; Palmagent rejects plaintext authentication origins and non-loopback binds.

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
| `settings` | `palmagent config`, `palmagent auto-update` | Manage shared preferences and the automatic update timer |
| `install` | `palmagent install` | Install Palmagent and configure HTTPS and a first passkey |
| `setup` | `palmagent setup` | Reconfigure an existing installation |
| `doctor` | `palmagent doctor` | Diagnose service and host integration problems |
| `update` | `palmagent update` | Plan and coordinate package/plugin updates, then verify the running version |

Skill bodies are authored once under `skills/` and synchronized to both plugin trees with
`node scripts/sync-skills.mjs`.

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
It registers the exact native session and waits for that CLI process to close.
The task remains unavailable for follow-up until new transcript messages have been
imported. Both directions retain the native session ID and working directory;
Palmagent stores normalized display events and a checked synchronization cursor.
It never copies credentials or rewrites the provider's transcript. Returning tasks
keep their Palmagent permission/model choices; newly imported tasks use Palmagent's
provider defaults. Select the next turn's settings in the task composer.

Transfers currently require Linux, a shared local provider home, and a native JSONL
transcript of at most 64 MiB. Missing, rewritten, incomplete, or identity-mismatched
transcripts leave the transfer pending with an error. No turn starts automatically
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

Ask **“Turn on automatic updates”** to enable background checks about every six
hours on an installed service. Automatic updates are off by default and follow
your saved Stable/Preview channel. They stay within the current `x.x.x` version
line, keep plugins, and defer while tasks are running, queued, or waiting for you.
A version that needs a plugin change waits for a plugin-assisted update.
With the current compatibility rule, a new Stable patch also needs that flow;
automatic advancement currently applies to prereleases within the same version line.

Ask **“Show my update settings”** to check the preference, timer, and last result,
or **“Turn off automatic updates”** to stop future attempts. An update already
applying is allowed to finish. Failed installations pause automatic retries until
a successful manual recovery. See the [update policy](.harness/skills/release/references/channels-and-updates.md#coordinated-and-automatic-updates).

## Development

Requirements: Node.js 22 or newer and pnpm 11.5.2 (pinned by `packageManager`).

Install dependencies and start the server:

```bash
pnpm install
pnpm dev
```

For PWA development, run `pnpm web:dev` in another terminal. See the
[web development guide](apps/web/README.md) for local ports and UI checks.

Follow the [verification skill](.harness/skills/verify/SKILL.md) before submitting a change.
Documentation and skill-only edits use its scoped checks. For code, dependencies,
workflows, or uncertain scope, run the complete source gate:

```bash
pnpm verify
```

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
