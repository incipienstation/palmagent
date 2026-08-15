# Palmagent

Palmagent is a self-hosted dispatcher for running Claude Code and Codex from one
agent-neutral interface. The project combines a server, a mobile-first PWA, a public CLI, and
operator plugins for both agent platforms.

This repository is being assembled as Palmagent's public source monorepo. The first migration
slice establishes the workspace and shared wire contracts while preserving the existing plugin
distribution. Runtime applications and the publishable CLI will be imported in later reviewed
slices; the repository remains private until the public-safety audit is complete.

## Current layout

```text
packages/shared/                     Shared events, task state, permissions, and wire DTOs
skills/                              Canonical operator skill bodies
plugins/claude/                      Claude Code plugin distribution
plugins/codex/                       Codex plugin distribution
.claude-plugin/marketplace.json      Claude Code marketplace entry
```

The root package is private workspace coordination only. Publishable packages use the
`@palmagent/*` scope, except for the future public `palmagent` CLI package.

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

```bash
pnpm install
pnpm typecheck
pnpm plugins:check
pnpm verify
```

See [AGENTS.md](AGENTS.md) for repository architecture, privacy constraints, and contribution
workflow.

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
