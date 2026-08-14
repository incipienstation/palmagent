# Palmagent — Codex operator plugin

> These wrappers always invoke the CLI by its `bin` name **`palmagent`** — the CLI is the brain,
> the skills are thin skins over it.

This is the **Codex frontend** for the self-hosted Palmagent. It is the mirror
of the Claude Code plugin in `plugins/claude/`. Both are **thin skins** over one deterministic
CLI: `palmagent install | setup | doctor | update | uninstall`. The CLI is the brain;
these skills just locate it, confirm intent conversationally, run it, and — for `doctor` — add
adaptive, journal-driven diagnosis. No orchestration logic is duplicated here.

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

Once this repo is published, the same plugin installs straight from git (no clone):

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

> **Not used:** loose `~/.codex/prompts/` or `~/.codex/commands/` files. On codex 0.139.0 those
> directories are empty with no documented schema and no `codex prompts` subcommand, so shipping
> them would be unverified guesswork. Skills are the verified, model-invokable surface.

## Prerequisite: the CLI must be reachable

These skills assume the `palmagent` CLI is on `PATH` (global `npm i -g palmagent`) or
runnable via `npx palmagent`. The skills probe for it first and fall back to `npx`.

## Single source for skill bodies

The two platforms differ **only** in their discovery wrappers — Claude reads
`/.claude-plugin/marketplace.json` → `plugins/claude/.claude-plugin/plugin.json` →
`skills/<s>/SKILL.md`; Codex reads a `.agents/plugins/marketplace.json` marketplace root →
`.codex-plugin/plugin.json` → `skills/<s>/SKILL.md`, plus this per-skill `agents/openai.yaml`
chip file Claude does not read. The **`SKILL.md` bodies are identical** across both.

To keep them from drifting, each body is authored once in the repo-root `skills/<name>/SKILL.md`
and copied verbatim into both platform trees by `scripts/sync-skills.mjs`. CI runs
`sync-skills.mjs --check` to forbid drift. **Edit the canonical `skills/<name>/SKILL.md`, then run
the script — never hand-edit the generated copies.** The manifests and `openai.yaml` chips stay as
thin per-platform glue.

> Symlinks were rejected: consumers clone this repo directly, and some clients
> (Windows / `core.symlinks=false`) materialize symlinks as plain text, while Codex
> `--sparse plugins/codex` would not fetch a link target outside the cone. Committed real files in
> every tree are robust everywhere.
