# Versioning and releases

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

## npm channels

Prereleases publish only to the `next` dist-tag. Stable releases publish to
`latest`.

| Version | npm tag | Install command |
| --- | --- | --- |
| `0.1.0-alpha.1`, `beta`, or `rc` | `next` | `npm install -g palmagent@next` |
| `0.1.0` and later stable versions | `latest` | `npm install -g palmagent` |

An installation that started on a prerelease stays on `next` when
`palmagent update --pull` runs. A stable installation stays on `latest`.

Published versions are immutable. Never overwrite or reuse a version. If a
release is bad, move the dist-tag back to the last good version, deprecate the
bad version with a useful message, and publish a new patch or prerelease.

## Environment and merge model

Palmagent keeps two long-lived branches because staging acceptance and
production release are separate gates.

| Branch | Environment role | Incoming pull request | Merge method |
| --- | --- | --- | --- |
| `develop` | staging source | `feature/*` or `hotfix-sync/*` | squash |
| `main` | production and release source | `develop` promotion or `hotfix/*` | merge commit |

Feature branches are short-lived and represent one logical change, so they are
squash-merged into `develop`. `develop` is long-lived: never squash or rebase a
`develop` promotion into `main`. Use a merge commit so the promoted commits
remain ancestors of `main`, later promotion pull requests contain only new
work, and the release boundary is explicit.

A successful merge or check does not prove that either environment changed.
Every staging or production deployment must record the exact source commit and
immutable artifact, then produce its own health evidence. Production should
promote the artifact accepted in staging when the delivery system supports
artifact promotion; it must not silently substitute an unreviewed build.

Repository merge methods are limited to squash and merge commit; rebase merge is
disabled. Active rulesets enforce squash for `develop` and merge commits for `main`.
Both branches require a pull request and the GitHub Actions `validate` check, and
block deletion and force pushes. These rules define branch and approval ownership;
staging and production deployment automation remain future work.

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

Before creating or pushing the tag, obtain approval for its exact version and
target `main` commit. Prior approval remains valid for the same reviewed action;
changes to the proposed version, release scope, or tag target require renewed
review. These are maintainer and agent procedure gates; the current workflow
checks tag validity but does not verify a human-approval record through the API.

1. Feature branches start from `origin/develop` and squash-merge into `develop`.
2. Deploy the exact accepted `develop` revision or artifact to staging and
   record staging health separately from CI.
3. After human approval of the version proposal, a release-preparation change
   updates the root version, both plugin manifests,
   and `CHANGELOG.md` in `develop`. Move the selected changes into a nonempty
   `## <version>` section (for example, `## 0.1.0-alpha.1`). Keep later work under
   `## Unreleased`.
4. Promotion from `develop` to `main` is a separate reviewed pull request using
   a merge commit.
5. After promotion and tag approval, create and push an annotated `v<version>`
   tag at the exact reviewed `main` commit. Never move, delete, or reuse release
   tags, even if the workflow fails.
6. The tag push validates that revision and creates a draft GitHub Release with
   the version's changelog notes, package, checksum, and provenance. Inspect the
   draft and record acceptance of its exact package before publication or host
   deployment.
7. Publishing the GitHub Release is the explicit publication approval.
8. npm publication, repository visibility, and production-host deployment remain
   separate gates. None is implied by a passing check, merge, tag, or draft.

Do not publish from a workstation or arbitrary branch. The eventual npm publish
job must use npm Trusted Publishing with the exact GitHub workflow identity,
minimal `contents: read` plus `id-token: write` permissions, and a protected
release environment.

## Candidate automation

The required `validate` check always runs metadata, skill synchronization, link,
version, and public-content checks. Known documentation and skill-only PRs need
no dependency installation or runtime tests. Code PRs add type/tooling checks and
the affected server or PWA tests; shared contracts exercise both. Classification
uses the complete PR diff, so a documentation follow-up does not hide earlier
code changes. Unknown paths or unavailable change history select the full gate.

Ordinary code PRs do not build or upload a deployment package. Packaging, CLI,
dependency, workflow, and unknown changes add packed-install verification for
trusted PRs, but do not upload a staging artifact. Same-repository checks require
the private-context denylist; fork PRs retain generic source leak checks without
repository secrets or publishable package generation.

Every `develop` push runs the full source gate, builds a package, runs isolated
packed-install smoke, and uploads the exact tested tarball named for the source
commit. Use that successful push artifact for staging and record its SHA-256
alongside the source commit. Every `main` push runs the full source gate; release
packages are produced by the separate workflow below. New PR revisions cancel
superseded PR runs. Branch integration runs are not cancelled by this policy.
This does not publish to npm or deploy a service.

`.github/workflows/release-candidate.yml` runs on `v*` tag pushes. It retains a
manual, artifact-only run on `main`; manual runs on tags or other branches are
skipped. A tag push:

1. requires an annotated tag matching the root version and the workflow commit;
2. verifies that commit is in `origin/main` history and has versioned release notes;
3. installs from the lockfile and runs the complete repository verification gate;
4. reuses the PWA built by the source gate to assemble the self-contained npm package;
5. requires the private-context `LEAK_DENYLIST` and version/plugin synchronization;
6. packs once, installs that tarball in a scratch project, and boots it;
7. uploads the package, `SHA256SUMS`, `release.json`, and notes as a 14-day workflow
   artifact named `palmagent-release-<commit>`;
8. downloads that artifact in a separate job, rechecks the tag identity and package
   checksum, then creates a draft GitHub Release with the package, checksum, and
   provenance attached. It does not rebuild the package in the draft job.

The candidate job has read-only repository permissions. Only the draft job has
`contents: write`, and its token is passed only to the draft step. Neither job has
registry credentials, OIDC permission, a release-publication step, or host access.
The draft command uses `--draft --verify-tag --latest=false`; alpha, beta, and rc
versions also use `--prerelease`. Supported tag versions are `vMAJOR.MINOR.PATCH`
and `vMAJOR.MINOR.PATCH-{alpha,beta,rc}.N`, with no leading zeroes or build metadata.

`release.json` records the tag object, source commit, version, intended npm channel,
package filename, SHA-256, and workflow URL. This is traceability metadata, not a
cryptographic attestation or evidence of npm publication. The tagged package is a
new candidate build; earlier staging acceptance does not automatically validate
its bytes. Verify this artifact in staging before deploying the identical package
to production.

Runs for a tag are serialized. Reruns never replace existing draft or published
release assets: if a release already exists, the draft job fails for human review.
An upload failure may leave a partial draft. Inspect it before any recovery;
published versions always require a new version. A failed run before draft creation
may be retried on the same unchanged tag. If source changes are needed, use a new
version and tag. Active `v*` tag rulesets restrict creation to repository admins
and block updates and deletion, including by admins. They are managed separately
from this workflow; future release automation needs its own reviewed tag-creation
permission.

After release preparation is promoted and the exact commit is approved, a
maintainer creates the annotated tag:

```bash
release_version='<version>'
release_commit='<reviewed-main-commit>'
git fetch origin main
git tag -a "v${release_version}" "$release_commit" -m "Palmagent ${release_version}"
git push origin "refs/tags/v${release_version}"
```

Replace the placeholders first. Push only the intended tag, not every local tag.
The commit must contain this workflow; adding automation to a later commit cannot
make it run for an older revision. GitHub tag-push event and draft-command behavior
are documented in the [Actions event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)
and [GitHub CLI reference](https://cli.github.com/manual/gh_release_create).

A publishing workflow must not be added until the npm Trusted Publisher and the
human approval mechanism have been reviewed and explicitly authorized.

## Release checklist

Before publishing a prerelease or stable release:

- `pnpm verify` passes.
- `PKG_PUBLISHABLE=1 pnpm pkg:build` passes.
- `EXPECT_PUBLISHABLE=1 pnpm release:check --artifact` passes.
- `REQUIRE_LEAK_DENYLIST=1 pnpm pkg:leakcheck` passes with the private denylist.
- `pnpm pkg:smoke` installs the tarball and boots the PWA and SQLite runtime.
- The tag is `v<root-version>` and points to the intended `main` commit.
- The generated tarball contains only the reviewed CLI, server, runner, PWA,
  README, license, and declared runtime dependencies.
- The changelog describes user-visible changes and upgrade considerations.
- Merge, publication, visibility, and host deployment approvals are recorded
  independently.

For stable releases, also verify a clean-host install, an update from the
previous stable version, database backup and quick-check, passkey login, HTTPS,
SSE reconnect, and rollback to the previous npm dist-tag.
