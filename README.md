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
docs/RELEASING.md                     Versioning, approval gates, and release runbook
.claude-plugin/marketplace.json      Claude Code marketplace entry
```

The root package remains private workspace coordination, but its version is the canonical
product version. Internal `@palmagent/*` packages remain private; the build assembles the
unscoped public `palmagent` package under `build/pkg`.

The runtime binds only to a loopback host. A reverse proxy must terminate HTTPS for every
public environment; Palmagent rejects plaintext authentication origins and non-loopback binds.

## Plugin skills

| Skill | CLI command | Purpose |
| --- | --- | --- |
| `install` | `palmagent install` | Install Palmagent and configure HTTPS and a first passkey |
| `setup` | `palmagent setup` | Reconfigure an existing installation |
| `doctor` | `palmagent doctor` | Diagnose service and host integration problems |
| `update` | `palmagent update` | Update while preserving in-flight work when possible |

Skill bodies are authored once under `skills/` and synchronized to both plugin trees with
`node scripts/sync-skills.mjs`.

## Development

Requirements: Node.js 22 or newer and pnpm 11.5.2 (pinned by `packageManager`).

Install dependencies and start the server:

```bash
pnpm install
pnpm dev
```

For PWA development, run `pnpm web:dev` in another terminal. See the
[web development guide](apps/web/README.md) for local ports and UI checks.

Run the complete source validation before submitting a change:

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
```

The source checks run without a live agent account. With an authenticated CLI, you can additionally
run `pnpm server:contracts:live -- --agent codex`. To check the assembled npm package, run
`pnpm pkg:build` followed by `pnpm pkg:smoke`.

Contribute through a `feature/*` branch from `develop` and a pull request targeting `develop`.
Keep private environment details out of source and examples. [AGENTS.md](AGENTS.md) contains
the instructions for coding agents working in this repository.

For releases, follow [docs/RELEASING.md](docs/RELEASING.md), which covers versioning, candidate
artifacts, and the separate merge, publication, visibility, and deployment gates.

## Install the operator plugin

### Claude Code

```text
/plugin marketplace add incipienstation/palmagent
/plugin install palmagent@palmagent
```

### Codex

```bash
codex plugin marketplace add incipienstation/palmagent --ref main --sparse plugins/codex
codex plugin add palmagent@palmagent
```

See [plugins/codex/README.md](plugins/codex/README.md) for Codex-specific details.

## License

[MIT](LICENSE)
