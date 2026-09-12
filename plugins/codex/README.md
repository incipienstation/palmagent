# Palmagent — Codex operator plugin

This is the Codex operator plugin for Palmagent, paired with the Claude Code plugin in
`plugins/claude/`. Both invoke the same `palmagent` CLI by its bin name. Skills locate the CLI,
confirm intent, and run it; `doctor` also guides diagnosis using service journals. Orchestration
logic stays in the CLI.

The contributed Codex **skills** (each invokable as a `$<name>` chip or model-triggered by its
description):

| Skill                | Drives            | Use it for                                   |
|----------------------|-------------------|----------------------------------------------|
| `settings` | Config and scheduler APIs | Manage channels and automatic updates |
| `install` | `palmagent install` | First-run install on a fresh host   |
| `setup`   | `palmagent setup`   | Reconfigure an existing install     |
| `doctor`  | `palmagent doctor`  | Diagnose a broken instance (+journal) |
| `update`  | `palmagent update`  | Plan, coordinate, and verify updates |

## Layout (verified against codex 0.139.0)

This directory **is a Codex marketplace root**: it holds `.agents/plugins/marketplace.json`
and a sibling `plugins/` dir, exactly like the installed `openai-curated` marketplace
(`~/.codex/.tmp/plugins/`). Each marketplace entry's `source.path` resolves relative to this
root.

```
plugins/codex/                                  ← marketplace ROOT (pass THIS to `marketplace add`)
├── README.md
├── .agents/plugins/marketplace.json            ← the Codex marketplace catalog
└── plugins/
    └── palmagent/                              ← the plugin (folder name == plugin.json "name")
        ├── .codex-plugin/plugin.json            ← required manifest
        └── skills/
            ├── settings/ SKILL.md + agents/openai.yaml
            ├── install/  SKILL.md + agents/openai.yaml
            ├── setup/    SKILL.md + agents/openai.yaml
            ├── doctor/   SKILL.md + agents/openai.yaml
            └── update/   SKILL.md + agents/openai.yaml
```

## Install (verified `codex plugin` commands, 0.139.0)

### Plugin path (recommended)

From a local checkout — point `marketplace add` at the **marketplace root** (this dir), not
the inner plugin folder:

```bash
# 1. Register the marketplace (use the absolute path to this directory):
codex plugin marketplace add /abs/path/to/repo/plugins/codex

# 2. Install the plugin  (plugin name @ marketplace name; both are "palmagent"):
codex plugin add palmagent@palmagent

# 3. Confirm it is installed + enabled, then start a NEW Codex thread to pick up the skills:
codex plugin list
```

Install a published release from GitHub. Replace `<version>` with a plugin version
sharing the CLI's `x.x.x` (including prereleases). Choose a stable tag for Stable
or opt into a prerelease tag for Preview:

```bash
codex plugin marketplace add incipienstation/palmagent --ref 'v<version>' --sparse plugins/codex
codex plugin add palmagent@palmagent
```

Manage / refresh / remove:

```bash
codex plugin marketplace upgrade            # refresh a git marketplace snapshot
codex plugin remove palmagent@palmagent
codex plugin marketplace remove palmagent
```

> After any (re)install, **start a new Codex thread** — that is the boundary at which Codex
> picks up new skills (verified in codex's bundled `plugin-creator` skill guidance).

## Shared user settings

The plugin handles CLI bootstrap and invocation internally. Users ask Palmagent to
install, update, or change preferences; they do not need to install or run the CLI.
Both agent platforms share `~/.palmagent/config.json`, outside plugin caches. The
`settings` skill reads and changes this file through the internal configuration API.
A saved channel survives new threads, plugin refreshes, and service reinstalls.
Automatic updates are opt-in through the same skill. They follow the saved channel
within the current compatibility line, retain plugins, and defer during active work.
The update skill coordinates a required plugin change through Codex's native manager.

A pinned marketplace does not advance when npm `latest` or `next` changes. A plugin
from a different `x.x.x` needs a compatible published release. See the root README
for channel selection and compatibility behavior.

## Single source for skill bodies

The two platforms differ **only** in their discovery wrappers — Claude reads
`/.claude-plugin/marketplace.json` → `plugins/claude/.claude-plugin/plugin.json` →
`skills/<s>/SKILL.md`; Codex reads a `.agents/plugins/marketplace.json` marketplace root →
`.codex-plugin/plugin.json` → `skills/<s>/SKILL.md`, plus this per-skill `agents/openai.yaml`
chip file Claude does not read. The **`SKILL.md` bodies are identical** across both.

To update a skill, edit the repo-root `skills/<name>/SKILL.md` and run
`node scripts/sync-skills.mjs`. CI checks that both platform copies match the source; do not
hand-edit them. Manifests and `openai.yaml` files remain platform-specific.

> Symlinks were rejected: consumers clone this repo directly, and some clients
> (Windows / `core.symlinks=false`) materialize symlinks as plain text, while Codex
> `--sparse plugins/codex` would not fetch a link target outside the cone. Committed real files in
> every tree are robust everywhere.
