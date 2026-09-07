# Palmagent — Codex operator plugin

This is the Codex operator plugin for Palmagent, paired with the Claude Code plugin in
`plugins/claude/`. Both invoke the same `palmagent` CLI by its bin name. Skills locate the CLI,
confirm intent, and run it; `doctor` also guides diagnosis using service journals. Orchestration
logic stays in the CLI.

The contributed Codex **skills** (each invokable as a `$<name>` chip or model-triggered by its
description):

| Skill                | Drives            | Use it for                                   |
|----------------------|-------------------|----------------------------------------------|
| `install` | `palmagent install` | First-run install on a fresh host   |
| `setup`   | `palmagent setup`   | Reconfigure an existing install     |
| `doctor`  | `palmagent doctor`  | Diagnose a broken instance (+journal) |
| `update`  | `palmagent update`  | Update in place (preserves turns)   |

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

Install directly from the GitHub repository:

```bash
codex plugin marketplace add incipienstation/palmagent --ref main --sparse plugins/codex
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

## Prerequisite: the CLI must be reachable

These skills assume the `palmagent` CLI is on `PATH` (global `npm i -g palmagent`) or
runnable via `npx palmagent`. The skills probe for it first and fall back to `npx`.

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
