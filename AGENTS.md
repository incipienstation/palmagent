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
- Open feature pull requests into `develop`, never directly into `main`, and squash-merge each
  reviewed feature pull request so it lands as one reversible change.
- `develop` is the source branch for staging. A merge or green check makes a revision eligible
  for staging deployment; it is not deployment evidence. Record the exact deployed commit or
  immutable artifact and verify staging health separately.
- A green check or PR does not authorize merge, publication, repository visibility changes, or
  deployment. Keep each of those as an explicit human approval gate.
- Promotion from `develop` to `main` is a separate reviewed pull request and uses a merge commit,
  never squash or rebase. This preserves the ancestry of the long-lived integration branch and
  makes each production/release promotion visible in `main`.
- `main` is the source branch for production deployment, version tags, and releases. Merging a
  promotion pull request does not itself authorize any of those actions.
- Hotfixes branch from `main` and merge into `main` with a merge commit. Immediately propagate the
  same fix through a short-lived branch from current `develop` and squash-merge it into `develop`
  so staging and the next promotion retain the fix without weakening either target's merge rule.
- Keep repository-level squash and merge-commit methods enabled and rebase merge disabled. When
  branch-targeted rulesets are available, restrict `develop` to squash and `main` to merge commits;
  until then, maintainers enforce the method at merge time.

## Versioning and releases

- Use one fixed product version for the generated npm package and both versioned plugin
  manifests. `pnpm release:check` enforces synchronization.
- Prereleases (`alpha`, `beta`, `rc`) use npm dist-tag `next`; stable releases use `latest`.
- A source version, green check, merge, tag, or draft release is not publication evidence.
- Never publish from a workstation or arbitrary branch. Candidate automation is read-only and
  produces an artifact only; it contains no registry or deployment credentials.
- A future publish job must use npm Trusted Publishing and a protected approval environment.
- Published versions are immutable. Deprecate a bad version, move the dist-tag back, and issue
  a new version rather than overwriting or reusing one.
- Keep npm publication, repository visibility, and host deployment as independent approvals.

See `docs/RELEASING.md` for the release train, gates, and rollback procedure.

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

`pnpm verify` is the source gate: workspace typechecking, executable Claude/Codex adapter
contracts, server runtime smoke, CLI render and HTTPS invariants, PWA Playwright and
service-worker checks, plugin synchronization, manifests, links, leak checks, and release-version
synchronization. Authenticated live adapter smoke is explicit and is not part of hermetic CI.
Release candidates additionally run the assembled-package leak check and packed-install smoke
described in `docs/RELEASING.md`.
