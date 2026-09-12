# Release automation and verification

## Candidate automation

Ordinary CI runs only on pull requests into `develop` or `main`, not on branch
pushes after merge. The required `validate` check always runs metadata, skill synchronization, link,
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

New PR revisions cancel superseded PR runs. Keep the required `validate` check
and the rule requiring PRs to be current with their base branch before merge.
There is no automatic post-merge validation or staging package build.

When a staging package is needed, manually run `staging-candidate.yml` on the
`develop` branch and provide the full 40-character `commit` SHA. The workflow
requires that exact commit to belong to `develop` history, then checks it out
separately from the workflow tools. It runs metadata/leak checks and package
build/install verification without repeating the PR runtime/browser suites.
The selected revision must support the current package assembly and smoke commands.

The resulting `palmagent-staging-<commit>` artifact contains the exact installed
tarball, `SHA256SUMS`, and `staging.json` with source and workflow commit IDs and
the run URL. Use that artifact for staging and record its checksum alongside
the source commit and staging health. Runs on other branches are skipped.
This workflow neither deploys a service nor publishes to npm or GitHub Releases.

`.github/workflows/release-candidate.yml` runs on `v*` tag pushes. It retains a
manual, artifact-only run on `develop` or `main`; manual runs on other refs are skipped. A tag push:

1. requires an annotated tag matching the root version and the workflow commit;
2. verifies prerelease ancestry in `origin/develop`, stable ancestry in `origin/main`, and versioned release notes;
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

`release.json` records the tag object, source branch and commit, version, intended npm channel,
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

After release preparation lands on the appropriate branch and the exact commit is approved,
a maintainer creates the annotated tag:

```bash
release_version='<version>'
release_commit='<reviewed-source-commit>'
git fetch origin develop main
git tag -a "v${release_version}" "$release_commit" -m "Palmagent ${release_version}"
git push origin "refs/tags/v${release_version}"
```

Replace the placeholders first. Push only the intended tag, not every local tag.
The commit must contain this workflow; adding automation to a later commit cannot
make it run for an older revision. GitHub tag-push event and draft-command behavior
are documented in the [Actions event reference](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)
and [GitHub CLI reference](https://cli.github.com/manual/gh_release_create).

## Protected npm publication

`.github/workflows/npm-publish.yml` runs when a human publishes a GitHub Release. Manual
`workflow_dispatch` on `main` or `develop` retries an already-published GitHub Release by exact
tag; it cannot publish a draft. It downloads existing assets and does not rebuild them.

The inspection job checks tag identity, channel ancestry, release metadata, checksums, and
clean package source identity before selecting `npm-next` or `npm-latest`. Prereleases proceed
automatically through `npm-next`; stable releases wait for the `npm-latest` environment reviewer.
The publication job downloads the assets again, verifies the same SHA-256,
and publishes through GitHub OIDC with provenance. It has `contents: read`, `actions: read`
(for environment validation), and `id-token: write`. No npm token or host credentials are used.
The job rejects an environment that does not match the release channel. Stable publication
fails closed unless `npm-latest` has required reviewers. Both channels require the repository
variable `NPM_PUBLISH_ENABLED` to be exactly `true`.

One-time setup, separate from any particular release:

1. Create GitHub environment `npm-next` without required reviewers or a wait timer, and
   `npm-latest` with the maintainer as a required reviewer. For a sole-maintainer repository,
   allow self-review on `npm-latest` so stable publication has a deliberate second approval.
   Restrict deployment refs on both environments to release tags (`v*`) plus `develop`/`main`
   for manual retries. Keep administrative protection bypass disabled.
2. In npm package settings for `palmagent`, configure GitHub Trusted Publishers for this
   repository, workflow filename `npm-publish.yml`, and each environment (`npm-next`,
   `npm-latest`). Confirm the authenticated npm account owns the package. No static npm token
   belongs in GitHub secrets. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
3. Set repository variable `NPM_PUBLISH_ENABLED=true` only after the trust mappings and each
   channel's environment policy are verified. Until then CI artifacts remain usable for staging.
4. The first release must include this workflow in its tagged source; make it available on the
   default branch for manual dispatch. Package/version/tag approvals remain independent of setup.

When migrating from reviewer gates on both channels, land the channel-aware validation first,
then remove required reviewers and any wait timer from `npm-next`. Preserve its environment,
deployment-ref restrictions, and Trusted Publisher binding; leave `npm-latest` unchanged.
Publication checks are loaded from the tagged source, including on manual retries. Tags created
before this policy change retain their old reviewer requirement and cannot be retried with a
reviewer-free `npm-next`. Do not move old tags or replace published assets to change that policy;
inspect an older release separately before planning recovery. New prerelease tags must include
the updated validation code to use automatic publication.

The workflow pins Node 24 and npm 11.11.1 on a GitHub-hosted runner. Publishing a prerelease
uses `next`; stable uses `latest`. It verifies the registry's SHA-512 integrity after upload.
A retry finding identical published bytes succeeds without republishing or moving dist-tags.
Different bytes at the same version fail; registry/auth/network errors are never treated as
proof that a version is absent. Verify the intended dist-tag separately after recovery:

```bash
npm view palmagent dist-tags --json
npm view palmagent@<version> dist.integrity
```

To recover a bad release, explicitly approve deprecation and a dist-tag correction, then issue
a new version. Do not overwrite a published version or move a release tag. Host rollback is a
separate operation; see [staging rollback](../../../../docs/STAGING.md#rollback-and-failures). Reverting an npm tag
does not downgrade an already-installed host or restore a database.

## Release checklist

Before publishing a prerelease or stable release:

- `pnpm verify` passes.
- `PKG_PUBLISHABLE=1 pnpm pkg:build` passes.
- `EXPECT_PUBLISHABLE=1 pnpm release:check --artifact` passes.
- `REQUIRE_LEAK_DENYLIST=1 pnpm pkg:leakcheck` passes with the private denylist.
- `pnpm pkg:smoke` installs the tarball and boots the PWA and SQLite runtime.
- The tag is `v<root-version>` and points to the intended channel-source commit.
- The generated tarball contains only the reviewed CLI, server, runner, PWA,
  README, license, build identity, and declared runtime dependencies.
- The changelog describes user-visible changes and upgrade considerations.
- Merge, publication, visibility, and host deployment approvals are recorded
  independently.

For stable releases, also verify a clean-host install, an update from the
previous stable version, database backup and quick-check, passkey login, HTTPS,
SSE reconnect, and rollback to the previous npm dist-tag.
