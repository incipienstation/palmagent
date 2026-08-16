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

Repository merge methods are intentionally limited to squash and merge commit;
rebase merge is disabled. Branch-targeted rulesets should enforce squash for
`develop` and merge commits for `main` when rulesets are available. Until then,
the reviewer selecting the merge method is the enforcement gate. This policy
defines branch and approval ownership only; it does not claim that staging or
production deployment automation already exists.

Hotfixes branch from `main` and return to `main` through a reviewed pull request
using a merge commit. After landing, create a short-lived branch from current
`develop`, apply the same fix there, and squash-merge that sync pull request into
`develop`. Verify staging again before the next promotion. Do not merge the
long-lived `main` branch directly into `develop` in a way that bypasses the
target branch's squash-only rule.

## Branch and approval flow

1. Feature branches start from `origin/develop` and squash-merge into `develop`.
2. Deploy the exact accepted `develop` revision or artifact to staging and
   record staging health separately from CI.
3. A release-preparation change updates the root version and `CHANGELOG.md` in
   `develop`.
4. Promotion from `develop` to `main` is a separate reviewed pull request using
   a merge commit.
5. After promotion, create an annotated `v<version>` tag at the exact reviewed
   `main` commit.
6. Create a draft GitHub Release from that tag and inspect its notes and package
   artifact.
7. Publishing the GitHub Release is the explicit publication approval.
8. npm publication, repository visibility, and production-host deployment remain
   separate gates. None is implied by a passing check, merge, tag, or draft.

Do not publish from a workstation or arbitrary branch. The eventual npm publish
job must use npm Trusted Publishing with the exact GitHub workflow identity,
minimal `contents: read` plus `id-token: write` permissions, and a protected
release environment.

## Candidate automation

`.github/workflows/release-candidate.yml` is deliberately non-publishing. It can
run manually only from `main` and:

1. installs from the lockfile;
2. runs the complete repository verification gate;
3. builds the PWA and the self-contained npm package from a clean checkout;
4. requires the private-context `LEAK_DENYLIST`;
5. validates version and plugin synchronization;
6. installs the packed tarball in a scratch project and boots it;
7. uploads the tarball as a short-lived workflow artifact.

The workflow has read-only repository permissions and contains no npm publish
command, npm token, OIDC permission, tag creation, release creation, visibility
change, or host deployment.

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
