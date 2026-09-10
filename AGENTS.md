# AGENTS.md

Guidance for coding agents maintaining the Palmagent repository.

## Context discipline

Keep instructions focused on context needed to act correctly; link to canonical guidance instead
of duplicating it. Use [garden](.harness/skills/garden/SKILL.md) to audit and propose context cleanup.
Write README documentation for human users and contributors, and AGENTS.md for agents doing
repository work. Retain shared facts where each audience needs them to act correctly.

## What this is

Palmagent's pnpm + Nx source monorepo contains the self-hosted dispatcher,
mobile-first PWA, public CLI, shared contracts, and Claude Code + Codex operator plugins. Migration
is intentionally incremental: import one coherent slice, sanitize it, verify it, and review it
before importing the next.

## Repository boundaries

- The root package is named `palmagent` and is always `private: true`; it coordinates the
  monorepo and is never published directly. Its `version` is the single product-version source.
- Internal packages use the `@palmagent/*` scope and stay private at `0.0.0`. The generated
  public CLI package owns the unscoped `palmagent` npm name and inherits the root version.
- Cross-tier contracts belong in `packages/shared`. Applications import them rather than
  redefining wire types.
- Do not add empty placeholder directories. Add a package or app only when its first working,
  reviewable slice is imported.
- Do not copy historical lockfiles across repositories. Regenerate the lockfile from declared
  dependencies and review it.

## Public-safety rule

Treat every committed byte and commit as public material. Never commit secrets, personal
email addresses, user-specific home paths, private domains or addresses, host inventories,
production data, CLI transcripts, database files, or private-repository references. Replace
environment-specific examples with explicit placeholders. Sanitize during import, not afterward.

`scripts/validate.mjs` scans version-controlled source candidates with generic leak patterns and
an optional `LEAK_DENYLIST`. It reports only file and line locations, never matched values.

For every import from a non-public source:

1. Use the source only as an unstaged working input; never preserve its Git history automatically.
2. Inventory every imported file and review code, comments, examples, fixtures, and metadata.
3. Rename repository and package identities before staging.
4. Remove private roadmap labels, personal context, environment details, and stale references to
   files that are not part of the imported slice.
5. Run both the generic leak guard and the private context denylist before committing.
6. State which files remain byte-identical because they contain reusable product code. Do not
   rewrite safe code merely to make the diff look different.

## Repository skill single source

Author repository-maintenance skills in `.harness/skills/<name>/SKILL.md`. Both
`.agents/skills/<name>` and `.claude/skills/<name>` must be relative directory symlinks to
`../../.harness/skills/<name>`. Add both links when adding a skill; `pnpm plugins:check` validates
the mapping. Keep Claude-specific hooks and settings under `.claude/`.

Local worktrees under `.harness/worktrees/` are ignored; `.harness/skills/` is tracked.

## Plugin skill single source

Each operator skill is authored once in `skills/<name>/SKILL.md`. Run
`node scripts/sync-skills.mjs` to copy it verbatim into:

- `plugins/claude/skills/<name>/SKILL.md`
- `plugins/codex/plugins/palmagent/skills/<name>/SKILL.md`

Never hand-edit generated skill copies. Platform manifests and Codex `agents/openai.yaml` files
remain platform-specific.

## Branching and delivery

- Branch `feature/*` from an up-to-date `origin/develop` in an isolated linked worktree.
- Open feature pull requests into `develop`, never directly into `main`, and squash-merge each
  reviewed feature pull request so it lands as one reversible change.
- `develop` is the source for staging, prerelease tags, and prereleases; `main` is the source for
  production deployment, stable version tags, and stable releases. Record the exact deployed commit
  or immutable artifact and verify health separately from CI or merge status.
- A green check or PR does not authorize merge, publication, repository visibility changes, or
  deployment. Keep each of those as an explicit human approval gate.
- Promote `develop` to `main` through a separate reviewed PR using a merge commit, never squash
  or rebase. Promotion does not itself authorize tagging, publication, or deployment.
- Before a hotfix or merge-settings change, follow the
  [environment and merge model](docs/RELEASING.md#environment-and-merge-model), including hotfix
  propagation to `develop` and branch-specific merge enforcement.

## Versioning and releases

For user- or operator-facing changes, follow the
[changelog writing rules](docs/RELEASING.md#changelog-writing-rules).

Before version edits, tags, publication, or release-workflow changes, read
[docs/RELEASING.md](docs/RELEASING.md) for version synchronization, channels, approval gates,
artifact verification, and recovery. Present the proposed version, scope, compatibility impact,
and validation evidence for explicit human approval before versioning or tagging. General
permission to proceed, green CI, or a merge is not versioning approval; automation must not
choose or bump versions. Never publish from a workstation or arbitrary branch.

Candidate automation creates reviewed draft assets. Publishing a prerelease GitHub Release
authorizes automatic npm publication through `npm-next` after validation. Stable publication
through `npm-latest` additionally requires an environment reviewer's approval.
Host deployment remains operator-initiated through [staging-deploy](.harness/skills/staging-deploy/SKILL.md).
Keep private environment bindings outside the repository; never infer staging or production from DNS.

## Commands

Run from the repository root:

```bash
pnpm install
pnpm typecheck
pnpm server:contracts
pnpm server:contracts:live -- --agent codex  # optional; requires an authenticated CLI
pnpm server:smoke
pnpm web:verify
pnpm plugins:check
pnpm pkg:check
pnpm pkg:build
pnpm pkg:smoke
pnpm release:check
pnpm verify
node scripts/sync-skills.mjs
```

`pnpm verify` is the full local source gate: workspace typechecking, executable Claude/Codex adapter
contracts, server runtime smoke, CLI render and HTTPS invariants, PWA Playwright and
service-worker checks, plugin synchronization, manifests, links, leak checks, and release-version
synchronization. Authenticated live adapter smoke is explicit and is not part of hermetic CI.
Release candidates additionally run the assembled-package leak check and packed-install smoke
described in `docs/RELEASING.md`.

CI runs only on PRs and always reports `validate`, with expensive checks selected by the complete
change scope.
For documentation and skill-only edits, local `pnpm plugins:check`, `pnpm release:check`, and
`git diff --check` are sufficient. Follow the [CI and candidate policy](docs/RELEASING.md#candidate-automation)
for code checks and manual staging packages. Build the PWA before using `web:verify:built` or
`pkg:assemble`; those commands deliberately reuse existing output within the same verified run.
