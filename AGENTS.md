# AGENTS.md

Guidance for coding agents maintaining the Palmagent repository.

## Context and scope

- At task start, read current instructions and only the skills and references needed. Reuse unchanged
  instructions; after switching checkouts or before relying on a rule to pause, compare current files,
  including local edits. Read changed or missing context.
- Use current files, history, and the user's latest decisions over stale snapshots. Carry authorization
  through follow-ups in the same scope; ask only about unresolved ambiguity or new actions.
- Investigations and proposals end with findings. For requested changes, carry out the authorized work;
  read linked references when they affect a decision. Keep searches and output focused; store full
  test logs outside the repository and inspect relevant excerpts.
- Use [garden](.harness/skills/garden/SKILL.md) for documentation, skill, and instruction cleanup.
- Write human-facing guidance in `README.md` or `docs/`; keep agent workflow in `AGENTS.md` and skills.

## Repository boundaries

- The root `palmagent` package is private and owns the product version; generated public artifacts
  inherit it. Internal packages use `@palmagent/*` and remain private at `0.0.0`.
- Put cross-tier contracts in `packages/shared`. Add a package or app only with its first working
  slice; do not copy historical lockfiles, regenerate from declared dependencies.

## Public safety

Treat every committed byte and commit as public. Never include secrets, personal paths, private
domains, host inventories, production data, transcripts, databases, or private-repository
references. Use explicit placeholders for environment-specific examples. `scripts/validate.mjs`
checks version-controlled source and reports file and line only.

When importing from a non-public source, use it only as unstaged input and do not preserve its
history. Inventory and review every imported file, including code and metadata; rename identities,
remove private or stale context, and run the leak guard before committing. Report files kept
byte-identical as reusable product code; do not rewrite safe code for appearance.

## Skill sources

- Author repository-maintenance skills in `.harness/skills/<name>/SKILL.md`; add
  `.agents/skills/<name>` and `.claude/skills/<name>` as relative directory symlinks to that source.
  `pnpm plugins:check` validates them. Keep Claude-specific hooks and settings under `.claude/`.
- Author operator skills in `skills/<name>/SKILL.md` and shared references in `skills/.shared/`.
  Run `node scripts/sync-skills.mjs` to update Claude and Codex copies; never edit generated copies
  by hand or add `SKILL.md` under `.shared/`. Keep platform manifests and Codex
  `agents/openai.yaml` files platform-specific.
- Local task worktrees belong under the ignored `.harness/worktrees/` directory.

## Implementation and delivery

Use the [plan](.harness/skills/plan/SKILL.md) → [start](.harness/skills/start/SKILL.md) →
[verify](.harness/skills/verify/SKILL.md) → [ship](.harness/skills/ship/SKILL.md) workflow for
implementation. Start feature branches from current `origin/develop` in isolated worktrees. Open
feature PRs into `develop` and squash-merge after required checks and review. An authorized
implementation includes merge, safe task-worktree cleanup, and updating the primary local
`develop`; follow `ship` unless the user requests PR-only, draft, merge hold, or worktree retention.

Promote `develop` to `main` only through a reviewed PR with a merge commit. Other `main` merges
require explicit approval. Visibility is a separate approval. Product changes on `develop` may
qualify for automatic Preview publication; installations follow their saved update settings. For
host operations, record the deployed commit or artifact and verify health separately from merge or
CI status.

## Releases and verification

Use [release](.harness/skills/release/SKILL.md) before version edits, tags, publication,
release-workflow, hotfix, or merge-policy changes. It owns changelog rules, channel policy,
approvals, candidate checks, and recovery. Never publish from a workstation. See
[validation environments](docs/STAGING.md) for staging.

Run `node scripts/verify-local.mjs` for checks selected from the complete task diff. Known
documentation and skill changes use metadata checks; unknown scope runs the full gate. `pnpm verify`
runs the full local source gate. Release candidates also require full source and packed-install
verification per the [candidate policy](.harness/skills/release/references/automation.md#candidate-automation).
Build the PWA before reusing `web:verify:built` or `pkg:assemble` output.
