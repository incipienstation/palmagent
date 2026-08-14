# CLAUDE.md

Guidance for Claude Code maintaining this repository. **This repo is maintained by Claude Code.**

## What this is

The **Palmagent operator plugin marketplace** — thin Claude Code + Codex skins over the published
`palmagent` CLI (`install` / `setup` / `doctor` / `update`). It ships only marketplace manifests +
skill markdown; there is **no runtime code** here.

## Hard rule: decoupling (non-negotiable)

This repo references **only the published `palmagent` CLI**, by its `bin` name. It must contain
**zero context about any other repository** — no other repo's name, no internal file paths, no
infrastructure hostnames, no personal data. Describe behavior in terms of the `palmagent` CLI
command, never its implementation or where it is built.

The CI **leak guard** (`scripts/validate.mjs` + the `LEAK_DENYLIST` repo secret) enforces this and
fails the build on a violation. On a leak-guard failure it prints `file:line` only (values are
redacted) — open those lines and remove the offending content.

## Single source for skill bodies

Each skill body is authored **once** in `skills/<name>/SKILL.md` (canonical, platform-neutral,
short names: `install` / `setup` / `doctor` / `update`). `scripts/sync-skills.mjs` copies it
verbatim into both platform trees:

- `plugins/claude/skills/<name>/SKILL.md`
- `plugins/codex/plugins/palmagent/skills/<name>/SKILL.md`

**Edit the canonical `skills/<name>/SKILL.md`, then run `node scripts/sync-skills.mjs` — never
hand-edit the generated copies.** CI runs `sync-skills.mjs --check` to forbid drift. The Codex
`agents/openai.yaml` chip files and the manifests are thin per-platform glue, edited directly.
Symlinks are intentionally not used (clients clone this repo directly; symlinks are fragile across
platforms and sparse checkouts).

## Branching

`main` / `develop` / `feature/*`:

- **`main`** — stable; the branch consumers pull (`--ref main`, and the Claude default branch).
  Keep it green.
- **`develop`** — integration branch; all feature work targets it.
- **`feature/*`** — branch off `develop`; PR back into `develop`.
- **Release** = a separate, deliberate `develop` → `main` PR. There is **no publish or deploy**
  here — the `palmagent` CLI is published elsewhere; this repo's "release" is the `main` merge that
  consumers pull.

Branch protection (require the `validate` check + PR) is plan-gated while the repo is private;
enable it when the repo goes public.

## Work loop: plan → start → verify → ship

Use the repo skills `/plan`, `/start`, `/verify`, `/ship`:

- **plan** — scope the change; read this file + the canonical / manifest / doc you will touch.
- **start** — work in a git **worktree** (enforced by a hook); branch a `feature/*` off `develop`.
- **verify** — the gate: `node scripts/sync-skills.mjs --check` **and** `node scripts/validate.mjs`.
- **ship** — small commits; open a PR into **`develop`**; squash-merge once CI is green.

## Editing is worktree-only

`.claude/hooks/require-worktree.sh` blocks Edit/Write in the main checkout — call `EnterWorktree`
first. Commit with a **GitHub noreply** git identity (never a personal email); this repo is
public-bound, so personal data must never enter its content or history.

## Commands

```bash
node scripts/sync-skills.mjs          # regenerate platform copies from skills/<name>/SKILL.md
node scripts/sync-skills.mjs --check  # CI: fail if the copies drift from the canonical
node scripts/validate.mjs             # CI: manifests, structure, links, leak guard
```
