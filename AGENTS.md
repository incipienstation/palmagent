# AGENTS.md

Guidance for coding agents maintaining the Palmagent repository.

## What this is

Palmagent's public-bound pnpm + Nx source monorepo. It will contain the self-hosted dispatcher,
mobile-first PWA, public CLI, shared contracts, and Claude Code + Codex operator plugins. Migration
is intentionally incremental: import one coherent slice, sanitize it, verify it, and review it
before importing the next.

The repository remains private until the migration and public-safety audit are complete.

## Repository boundaries

- The root package is named `palmagent` and is always `private: true`; it coordinates the
  monorepo and is never published.
- Internal packages use the `@palmagent/*` scope. The future public CLI package owns the
  unscoped `palmagent` npm name.
- Cross-tier contracts belong in `packages/shared`. Applications import them rather than
  redefining wire types.
- Do not add empty placeholder directories. Add a package or app only when its first working,
  reviewable slice is imported.
- Do not copy historical lockfiles across repositories. Regenerate the lockfile from declared
  dependencies and review it.

## Public-safety rule

Treat every committed byte and commit as future public material. Never commit secrets, personal
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

## Plugin skill single source

Each operator skill is authored once in `skills/<name>/SKILL.md`. Run
`node scripts/sync-skills.mjs` to copy it verbatim into:

- `plugins/claude/skills/<name>/SKILL.md`
- `plugins/codex/plugins/palmagent/skills/<name>/SKILL.md`

Never hand-edit generated skill copies. Platform manifests and Codex `agents/openai.yaml` files
remain platform-specific.

## Branching and delivery

- Branch `feature/*` from an up-to-date `origin/develop` in an isolated linked worktree.
- Open feature pull requests into `develop`, never directly into `main`.
- A green check or PR does not authorize merge, publication, repository visibility changes, or
  deployment. Keep each of those as an explicit human approval gate.
- Promotion from `develop` to `main` is a separate reviewed pull request.

## Commands

Run from the repository root:

```bash
pnpm install
pnpm typecheck
pnpm plugins:check
pnpm verify
node scripts/sync-skills.mjs
```

`pnpm verify` is the current complete gate: workspace typechecking plus plugin synchronization,
manifest, link, and leak checks. Expand it when runtime applications introduce additional tests.
