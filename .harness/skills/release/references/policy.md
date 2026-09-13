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
  entries, then follow the [release flow](#branch-and-approval-flow) to move it into
  the selected version section. Keep `Unreleased` first and version sections newest first.
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
A requested Stable release also authorizes its verified promotion PR into `main`; other `main`
merges retain explicit human approval. This policy applies to the PR being shipped;
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
npm publication uses channel environments: eligible Preview changes publish after their required
PR CI passes, while Stable waits for one reviewer approval before tag creation and publication. Staging uses
an explicit operator command.

Hotfixes branch from `main` and return to `main` through a reviewed pull request
using a merge commit. After landing, create a short-lived branch from current
`develop`, apply the same fix there, and squash-merge that sync pull request into
`develop`. Verify staging again before the next promotion. Do not merge the
long-lived `main` branch directly into `develop` in a way that bypasses the
target branch's squash-only rule.

## Branch and approval flow

Preview has standing authorization for publication when product changes enter `develop`.
Stable begins with a maintainer's release request, including a request in an agent session;
the maintainer does not need to click Run workflow. Carry forward that scope without asking
again for version edits, preparation PRs, or promotion. A request to inspect or propose only
still stops before mutation. An explicit draft, PR-only request, or merge hold takes precedence.

| Phase | Preview | Requested Stable release |
| --- | --- | --- |
| Version, changelog, preparation PR and checks | Automatic preparation; maintainer approves bot PR workflow execution | Prepare automatically; present in final evidence |
| Channel-source merge | Squash into `develop` | Dedicated `develop` to `main` PR, merge commit after required checks |
| Exact candidate build and verification | Automatic | Automatic, before final approval |
| Annotated tag | Automatic, after preparation merge | After final approval |
| npm publication and public GitHub Release | Automatic through `npm-next` | Same final `npm-latest` approval |
| Host deployment or repository visibility | Separate request | Separate request |

### Preview

`preview-release.yml` compares the latest `develop` with the last **successfully published**
Preview, verified against GitHub Release metadata, the annotated tag, and npm package bytes.
Runtime source, shipped operator plugins/skills, product dependencies, and packaging inputs
qualify. Development docs, `.harness`, tests alone, and version/changelog preparation do not.
The release classifier is independent of CI test selection. The built-in GitHub token requires
maintainer approval before its preparation PR workflow can satisfy merge checks; see the
[approval and resume procedure](automation.md#automatic-preview). This execution constraint
does not add a Preview publication approval, but prevents fully unattended releases.

The controller serializes version selection, creates a metadata-only preparation PR, waits
for required CI/protections, and squash-merges the exact head. Later product merges are
coalesced into the latest pending run. Failed changes remain eligible until publication succeeds;
retained preparation and candidate evidence are resumed before selecting another version.

Keep the root's declared base and stage (`alpha`, `beta`, or `rc`), allocating the next unused
sequence across npm versions and remote tags. Advancing the base or stage is a deliberate
release-scope change, not inferred from commit messages. While an unpublished Stable version
is prepared on `develop`, Preview pauses. After Stable is published, the next product change
starts the next patch's `alpha.1` lane. Respect the CLI/plugin compatibility line when choosing
a different base; breaking changes require a suitable minor/major version.

Automatic preparation moves `Unreleased` into the selected version. If no notable user change
was recorded, it adds a maintenance note with the source comparison instead of inventing impact.
Notable and breaking changes still need meaningful changelog entries in their product PRs.

### Stable

For a requested Stable release, choose the version from scope and compatibility, prepare
versions/changelog on `develop`, verify and squash the preparation PR, then promote through
a dedicated PR into `main` using a merge commit. Required checks and repository review rules
still apply. This is preparation authorization, not permission to bypass protections.

Build and inspect the exact final `main` candidate and complete the applicable
[release checklist](automation.md#release-checklist). Present its version, source SHA, SHA-256,
release notes and compatibility impact, test results, and any remaining limitations. Dispatch
`npm-publish.yml` for that exact commit and candidate run. Its `npm-latest` environment approval
is the **single final human gate**, before tag creation, npm `latest`, and public GitHub Release.
Do not ask for an additional conversational publication approval. The approved tarball is
reused without rebuilding. Changed source or bytes require a new candidate and approval.

Preparation can be rejected or revised before this gate; do not create a Stable tag or expose
a public Release early. A Stable package has distinct bytes from a prerelease and needs its
own acceptance. Deprecation, dist-tag rollback, visibility changes, and host deployment are
separate decisions. A release never implicitly authorizes a service restart or database change.

`release:prepare` accepts a supplied version and supports a read-only preview. It synchronizes
root/plugin versions and release notes but never commits, tags, publishes, or deploys itself.
See [automation and recovery](automation.md#protected-npm-publication) for workflow invocation.
