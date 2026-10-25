<div align="center">
  <img src="apps/web/public/logo.svg" width="76" height="76" alt="Palmagent" />
  <h1>Palmagent</h1>
  <p><strong>A mobile-first, self-hosted dispatcher for Claude Code and Codex.</strong></p>
  <p>Start coding tasks, follow their progress, and pick up from your phone or desktop.</p>
  <p>
    <a href="https://github.com/incipienstation/palmagent/releases">
      <img src="https://img.shields.io/github/v/release/incipienstation/palmagent?include_prereleases=true&amp;label=latest%20release&amp;color=0f766e" alt="Latest release" />
    </a>
    <a href="LICENSE">
      <img src="https://img.shields.io/github/license/incipienstation/palmagent?color=0f766e" alt="MIT license" />
    </a>
  </p>
  <p>
    <a href="#quick-start">Get started</a> ·
    <a href="docs/USER-GUIDE.md">User guide</a> ·
    <a href="docs/HOST-INGRESS.md">Host setup</a> ·
    <a href="#development">Development</a>
  </p>
</div>

## How it works

```mermaid
flowchart LR
  client["Your phone or desktop"] --> palmagent["Palmagent<br/>on your host"]
  palmagent --> claude["Claude Code"]
  palmagent --> codex["Codex"]
  claude --> repos["Your repositories"]
  codex --> repos
  classDef brand fill:#0f766e,stroke:#0f766e,color:#ffffff
  class palmagent brand
```

## What you can do

| Capability | What it does |
| --- | --- |
| **Coordinate coding tasks** | Run Claude Code and Codex from one interface, [attach files](docs/USER-GUIDE.md#start-a-chat), see live progress, and queue follow-up messages with the [persistent message queue](docs/MESSAGES.md). |
| **Keep project context** | Organize tasks by [Space](docs/USER-GUIDE.md#spaces), optionally isolate work in Git worktrees, and schedule agent tasks or scripts with [routines](docs/USER-GUIDE.md#routines). |
| **Move between app and CLI** | [Hand off native CLI sessions](docs/USER-GUIDE.md#sessions-and-working-directories) or use [persistent Task and Space shells](docs/terminals.md). |
| **Manage from one place** | Use the Palmagent operator plugin for service setup and maintenance, and manage [release channels](docs/USER-GUIDE.md#choose-a-release-channel) and [updates](docs/USER-GUIDE.md#updates) through the plugin or app settings. |

## Quick start

The host needs Linux with systemd 254+, Node.js 22+, Git, and at least one authenticated
Claude Code or Codex CLI. Installation also checks the [user-service requirements](docs/DAEMON.md#ownership-and-platform-boundary),
including account lingering and delegated cgroup v2. Prepare a domain pointing to the host
for [HTTPS access](docs/HOST-INGRESS.md).

On that host, install the Palmagent plugin for Claude Code or Codex from a
[published release](https://github.com/incipienstation/palmagent/releases), replacing `v<version>`
below with its tag. Use a stable release tag for Stable or a prerelease tag for Preview.

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

Keep the Codex checkout at its original path because it is the local marketplace source. See the
[Codex plugin guide](plugins/codex/README.md) for version changes and recovery.

After installing the plugin, start a new agent session. Stable is the default when no channel
preference is saved. For Preview, first ask **“Use Preview for Palmagent.”** Selecting a
prerelease plugin tag does not change that preference; an unavailable Stable release does not
fall back to Preview.

Ask **“Install Palmagent for example.com”**, using your domain. The plugin installs the service,
configures HTTPS, and provides a single-use passkey enrollment link. Open it on your phone or
desktop to register access, then choose a Space and start a task.

## Before you expose Palmagent

> [!IMPORTANT]
> Agent processes run on the Palmagent host with the service account's access to files and tools.
> Choose repository paths and account access deliberately. The runtime binds to loopback; public
> access requires an HTTPS reverse proxy. See [host ingress and migration](docs/HOST-INGRESS.md) for
> setup and transport details.

## Documentation

| Guide | Covers |
| --- | --- |
| [User guide](docs/USER-GUIDE.md) | Spaces, routines, sessions, release channels, and updates |
| [Authentication and security](docs/SECURITY.md) | Passkeys, session expiry, access revocation, and HTTP protections |
| [Message delivery](docs/MESSAGES.md) | Queues, delivery behavior, and recovery |
| [Native supervisor](docs/DAEMON.md) | Rust runtime, OS adapters, updates and migration |
| [Session lifecycle](docs/SESSION-LIFECYCLE.md) | Session ownership and application updates |
| [Persistent shells](docs/terminals.md) | Task and Space shell access |
| [Skills](docs/SKILLS.md) | Selecting skills for messages |
| [Host ingress](docs/HOST-INGRESS.md) | HTTPS access, setup, and migration |
| [Web app development](apps/web/README.md) | Frontend development and UI checks |

## Development

The [backend architecture policy](docs/ARCHITECTURE.md) defines feature ownership,
ports, adapters, composition and dependency checks. Native runtime builds also require
rustup and the toolchain pinned in [`rust-toolchain.toml`](rust-toolchain.toml).

Use the Node.js version in [`.nvmrc`](.nvmrc) and the pnpm version pinned in
[`package.json`](package.json):

```bash
nvm install
nvm use
pnpm install
pnpm dev
```

To run the web app, start `pnpm web:dev` in another terminal. Run
`node scripts/verify-local.mjs` to select checks for the complete change.

## License

[MIT](LICENSE)

Performance sharing and Rust migration comparisons are described in [Performance measurements](docs/TELEMETRY.md).
