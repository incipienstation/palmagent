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

## Layout (verified against codex 0.154.0)

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

## Install (verified `codex plugin` commands, 0.154.0)

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
git clone --depth 1 --branch 'v<version>' https://github.com/incipienstation/palmagent.git '/abs/path/to/palmagent-v<version>'
codex plugin marketplace add '/abs/path/to/palmagent-v<version>/plugins/codex'
codex plugin add palmagent@palmagent
```

Use an unused absolute checkout directory and retain it as the marketplace source.
The catalog lives below the repository root: `--sparse plugins/codex` limits the Git
checkout but does not change the marketplace root, so registering the repository URL
with that flag fails. Register the local `plugins/codex` directory instead.

To change versions, prepare a separate checkout of the exact published tag and verify
its plugin manifest first. Record the old source path and installed version, then use
native remove/add commands to repoint only the Palmagent marketplace and reinstall
its plugin. Inspect the registered source and installed manifest afterward; re-adding
an existing marketplace can retain its old source. Keep the old checkout for recovery.
A local marketplace does not advance through `marketplace upgrade`.

Remove:

```bash
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

Common CLI preparation lives in `skills/.shared/bootstrap.md` in the source repository.
Each skill links `../.shared/bootstrap.md`; synchronization includes a real copy inside
both plugin packages. `.shared` is our helper-directory convention, not a manifest field
or automatically loaded context. Both [Codex](https://developers.openai.com/plugins/build/skills#add-supporting-resources)
and [Claude Code](https://code.claude.com/docs/en/skills#add-supporting-files) support explicitly
referenced files. Keep the helper directory without a `SKILL.md` so it is not another skill.

To update a skill or shared reference, edit its repo-root source under `skills/` and run
`node scripts/sync-skills.mjs`. CI checks that both platform copies match the source; do not
hand-edit them. Manifests and `openai.yaml` files remain platform-specific.

> Symlinks were rejected: consumers clone this repo directly, and some clients
> (Windows / `core.symlinks=false`) materialize symlinks as plain text, and a sparse
> checkout would not fetch a link target outside its selected directories. Committed real files in
> every tree are robust everywhere.
