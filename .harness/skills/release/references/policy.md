# Release policy

Palmagent uses one fixed product version for every user-facing artifact. The root
`package.json` is the canonical version source even though the workspace remains
`private: true` and is never published directly.

The generated `palmagent` npm package and both versioned plugin manifests must
match the root version. Internal workspace packages remain private at `0.0.0`;
they are implementation boundaries, not independently supported products.
`pnpm release:check` enforces these rules.

## Version policy

Palmagent follows Semantic Versioning.

- `0.1.0-alpha.N` is for packaging and maintainer installation tests.
- `0.1.0-beta.N` is for an explicitly announced public preview.
- `0.1.0-rc.N` is for clean-host install, update, recovery, and rollback rehearsal.
- `0.1.0` is the first stable release.
- Before 1.0, a compatibility-breaking change increments the minor version and
  a compatible fix increments the patch version.
- After 1.0, major, minor, and patch have their standard SemVer meanings.

A version in source is only a candidate identifier. It is not evidence that the
version was tagged, published to npm, deployed to a host, or made public.

## Changelog writing rules

[`CHANGELOG.md`](../../../../CHANGELOG.md) records notable changes for users and installation operators.

- Update `## Unreleased` in the PR that introduces a meaningful change. A PR containing only
  internal refactoring, CI maintenance, or minor documentation edits needs no changelog entry
  unless it changes how users or operators use, install, update, or recover Palmagent.
- Describe the resulting behavior and its impact in plain language. Combine related commits
  into one entry; do not copy commit logs or PR titles wholesale.
- Group entries under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`,
  including only categories with entries. Explicitly describe breaking changes, deprecations,
  and required upgrade or recovery steps, linking to detailed instructions when needed.
- Keep branch policies, approval gates, and CI procedures in the release skill references. Put host
  deployment and rollback instructions in the [staging runbook](../../../../docs/STAGING.md). Changelog entries
  may summarize a new operator capability without duplicating its procedure.
- During release preparation, review `Unreleased` for accuracy, omissions, and duplicate
  entries, then follow the [version approval flow](#branch-and-approval-flow) to move it into
  the approved version section. Keep `Unreleased` first and version sections newest first.
  Use exact `## <version>` headings; release automation extracts that section for GitHub
  Release notes. Preparing the section does not mean the version has been published.

## Environment and merge model

Palmagent keeps two long-lived branches because staging acceptance and
production release are separate gates.

| Branch | Environment role | Incoming pull request | Merge method |
| --- | --- | --- | --- |
| `develop` | staging and prerelease source | `feature/*` or `hotfix-sync/*` | squash |
| `main` | production and stable release source | `develop` promotion or `hotfix/*` | merge commit |

Feature branches are short-lived and represent one logical change, so they are
squash-merged into `develop`. `develop` is long-lived: never squash or rebase a
`develop` promotion into `main`. Use a merge commit so the promoted commits
remain ancestors of `main`, later promotion pull requests contain only new
work, and the release boundary is explicit.

For an authorized task, [ship](../../ship/SKILL.md) automatically squash-merges its
verified, non-draft PR into `develop` after required checks and repository review requirements
are satisfied. A user request for PR-only delivery, a draft, or a merge hold takes precedence.
Merges into `main` retain explicit human approval. This policy applies to the PR being shipped;
it does not enable unattended merging of unrelated repository PRs.

A successful merge or check does not prove that either environment changed.
Every staging or production deployment must record the exact source commit and
immutable artifact, then produce its own health evidence. Production should
promote the artifact accepted in staging when the delivery system supports
artifact promotion; it must not silently substitute an unreviewed build.

Repository merge methods are limited to squash and merge commit; rebase merge is
disabled. Active rulesets enforce squash for `develop` and merge commits for `main`.
Both branches require a pull request and the GitHub Actions `validate` check, and
block deletion and force pushes. These rules define branch and approval ownership;
npm publication uses channel environments: prereleases publish automatically after Release
publication and validation, while stable releases require an additional reviewer. Staging uses
an explicit operator command.

Hotfixes branch from `main` and return to `main` through a reviewed pull request
using a merge commit. After landing, create a short-lived branch from current
`develop`, apply the same fix there, and squash-merge that sync pull request into
`develop`. Verify staging again before the next promotion. Do not merge the
long-lived `main` branch directly into `develop` in a way that bypasses the
target branch's squash-only rule.

## Branch and approval flow

Human review is required before versioning is executed. First present a reviewable
proposal with the current and proposed versions, release scope, compatibility
impact, draft changelog, and validation evidence. Record explicit human approval
in the release PR, issue, or maintainer conversation before editing version fields.
Approval to implement automation, a general instruction to proceed, green CI, or
a merge does not authorize a version change. Agents and workflows must not select
or bump the version automatically.

Before creating or pushing a tag, obtain approval for its exact version and target commit:
`develop` ancestry for prereleases, `main` ancestry for stable versions. Prior approval remains
valid for the same reviewed action. The tag workflow validates identity and ancestry; it does
not invent a version or infer approval from a merge.

1. Squash feature PRs into `develop`. When staging acceptance is needed, manually run
   `staging-candidate.yml` for the approved source commit and deploy its exact tested tarball.
   Ordinary merges do not build a package, tag, publish, or deploy.
2. Propose a concrete prerelease version and release scope. Preview the version change with
   `pnpm release:prepare <version>`; after explicit approval add `--apply`. This synchronizes
   the root and plugin manifests and moves `Unreleased` notes into the chosen version.
3. Review and squash that preparation PR into `develop`. Approve and create an annotated
   `v<version>` tag at its exact commit. Candidate CI creates a draft GitHub Release containing
   the tested package, checksum, and source identity.
4. Inspect the draft assets, then explicitly publish the prerelease GitHub Release. This is
   the final human publication approval: after validation, `npm-next` publishes to `next`
   automatically without a second reviewer gate.
5. Install `palmagent@<exact-version>` into staging using the [staging runbook](../../../../docs/STAGING.md).
   Record package checksum, source commit, runtime identity, and HTTPS/PWA checks.
6. For stable promotion, propose and approve a stable version. Prepare its version/changelog
   change in `develop`, then promote through a separate PR into `main` using a merge commit.
   Tag the reviewed `main` commit. Review its newly built artifact in staging, publish the
   GitHub Release, and approve `npm-latest`. A stable rebuild has distinct bytes and requires
   its own acceptance even when based on an accepted prerelease.
7. After stable promotion, propose the next development prerelease. Use
   `pnpm release:prepare <next-version> --development` to preview and `--apply` only after
   version approval. This updates versions while leaving unreleased work under `Unreleased`.
8. Repository visibility and production-host deployment remain separate approvals. No merge,
   tag, draft, npm publish, or staging deployment implicitly authorizes them.

`release:prepare` never chooses a version, commits, tags, publishes, or deploys. It rejects
backward versions and inconsistent manifests. See [publication and recovery](automation.md#protected-npm-publication).
