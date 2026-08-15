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

## Branch and approval flow

1. Feature branches start from `origin/develop` and merge into `develop`.
2. A release-preparation change updates the root version and `CHANGELOG.md` in
   `develop`.
3. Promotion from `develop` to `main` is a separate reviewed pull request.
4. After promotion, create an annotated `v<version>` tag at the exact reviewed
   `main` commit.
5. Create a draft GitHub Release from that tag and inspect its notes and package
   artifact.
6. Publishing the GitHub Release is the explicit publication approval.
7. npm publication, repository visibility, and production-host deployment remain
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
