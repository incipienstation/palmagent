# Palmagent

Palmagent is a self-hosted dispatcher for Claude Code and Codex. Use one mobile-first
web app to start tasks, follow their progress, and continue work from your own host.

## What you can do

- Run Claude Code and Codex tasks from one interface, with live updates and a [persistent message queue](docs/MESSAGES.md).
- Find repositories in server-side [Spaces](docs/USER-GUIDE.md#space-search-paths) and schedule [routines](docs/USER-GUIDE.md#routines).
- [Hand off native CLI sessions](docs/USER-GUIDE.md#sessions-and-working-directories), or use [persistent Task and Space shells](docs/terminals.md) in the web app.
- Manage service setup, [release channels](docs/USER-GUIDE.md#choose-a-release-channel), and [updates](docs/USER-GUIDE.md#updates) through the Palmagent operator plugin.

## Quick start

Install the Palmagent plugin for Claude Code or Codex from a published `v<version>` tag.
Choose a stable release tag for Stable or a prerelease tag for Preview.

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

Keep the Codex checkout at its original path because it is the local marketplace source.
See the [Codex plugin guide](plugins/codex/README.md) for version changes and recovery.

Start a new agent session after installing the plugin, then ask it to install Palmagent.
Stable is the default channel for a new installation. To opt into Preview, ask the plugin:
**“Use Preview for Palmagent.”**

## Before you expose Palmagent

Agent processes run on the Palmagent host with the service account's access to files and
tools. Choose the server's repository paths and account access deliberately. The runtime
binds to loopback; public access requires an HTTPS reverse proxy. See [host ingress and
migration](docs/HOST-INGRESS.md) for setup and transport details.

## Documentation

| Topic | Guide |
| --- | --- |
| Using Palmagent, configuring Spaces, routines, sessions, and updates | [User guide](docs/USER-GUIDE.md) |
| Message delivery, queues, and recovery | [Message guide](docs/MESSAGES.md) |
| Session ownership and application updates | [Session lifecycle](docs/SESSION-LIFECYCLE.md) |
| Persistent Task and Space shells | [Shell access](docs/terminals.md) |
| Selecting skills in messages | [Skill picker](docs/SKILLS.md) |
| Host ingress and migration | [Host ingress](docs/HOST-INGRESS.md) |
| Web app development and UI checks | [Web app guide](apps/web/README.md) |

## Development

Use the Node.js version in [`.nvmrc`](.nvmrc) and the pnpm version pinned in
[`package.json`](package.json):

```bash
nvm install
nvm use
pnpm install
pnpm dev
```

To run the web app during development, start `pnpm web:dev` in another terminal.
Run `node scripts/verify-local.mjs` to select local checks for the complete change.

## License

[MIT](LICENSE)
