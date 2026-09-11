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

Users see **Stable** (`latest`, default) and **Preview** (`next`, explicit opt-in).
Preview is available to everyone; developer status is not an access rule. Staging
is an environment role, not a public release channel or permission to access a host.

New installations save `--channel stable` by default; Preview users install
`palmagent@next` and run `palmagent install --channel preview`. Existing installations
without `RELEASE_CHANNEL` infer their current channel once from the installed version
and save it after a successful update/setup. An explicit saved choice takes precedence
over the installed version, including after Preview reaches a stable version.

- `palmagent update --pull` follows the saved channel.
- `palmagent update --pull --channel preview` opts into Preview.
- `palmagent update --pull --channel stable` returns to Stable when it can advance
  or retain the installed version. An older Stable target is refused.
- `palmagent update --pull --to <exact-version>` selects one release within the
  chosen channel policy without changing the saved channel. It does not create a
  permanent version pin. Stable rejects prereleases; all downgrades are refused.
- `--dry-run` shows the intended channel/spec without writing config or contacting
  npm. A real pull resolves and validates one exact version before installing it.

Registry errors and missing tags fail without switching channels. A channel choice is
saved only after update health succeeds; package or restart failure is not rolled back
automatically. Returning to an older version requires a separate database-aware rollback.

### CLI and operator plugin compatibility

Release artifacts still share one product version. Independently installed CLI and
plugin copies can differ within that version's `x.x.x`: for example, a `0.1.0-alpha.2`
plugin can pair with `0.1.0-beta.1`, `0.1.0-rc.1`, or `0.1.0`, but not `0.1.1` or `0.2.0`.
This is Palmagent's CLI contract promise, including prereleases; it is not a general
SemVer guarantee. Changes that break operator commands must move to a new base version.

`palmagent compatibility --plugin-version <version>` checks this mapping without
loading host configuration or changing anything. Operator skills read their own installed
manifest and require a successful check before invoking host operations. Older CLIs
without this command require an explicitly chosen compatible release before these skills
can run. Manual CLI use does not require a plugin.

npm dist-tags do not select plugin marketplace refs. Install a plugin from a published
`v<version>` tag in the same base version, using the platform's marketplace ref support.
A moving `main`/`develop` marketplace can include unpublished changes and is intended for
maintainer source testing. Plugin managers control refresh/caching separately, so a CLI
update is not evidence of a plugin update. The combined transactional updater remains a
follow-up; this release adds channel selection and compatibility preflight only.

Published versions are immutable. Never overwrite or reuse a version. If a
release is bad, move the dist-tag back to the last good version, deprecate the
bad version with a useful message, and publish a new patch or prerelease.

## Changelog writing rules

[`CHANGELOG.md`](../CHANGELOG.md) records notable changes for users and installation operators.

- Update `## Unreleased` in the PR that introduces a meaningful change. A PR containing only
  internal refactoring, CI maintenance, or minor documentation edits needs no changelog entry
  unless it changes how users or operators use, install, update, or recover Palmagent.
- Describe the resulting behavior and its impact in plain language. Combine related commits
  into one entry; do not copy commit logs or PR titles wholesale.
- Group entries under `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, or `Security`,
  including only categories with entries. Explicitly describe breaking changes, deprecations,
  and required upgrade or recovery steps, linking to detailed instructions when needed.
- Keep branch policies, approval gates, and CI procedures in this release runbook. Put host
  deployment and rollback instructions in the [staging runbook](STAGING.md). Changelog entries
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

For an authorized task, [ship](../.harness/skills/ship/SKILL.md) automatically squash-merges its
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
5. Install `palmagent@<exact-version>` into staging using the [staging runbook](STAGING.md).
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
backward versions and inconsistent manifests. Publishing and recovery are described below.

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
separate operation; see [staging rollback](STAGING.md#rollback-and-failures). Reverting an npm tag
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
