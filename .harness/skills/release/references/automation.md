# Release automation and verification

## Candidate automation

Ordinary CI runs only on pull requests into `develop` or `main`, not on branch pushes after merge.
The required `validate` check always runs metadata, skill synchronization, link,
version, and public-content checks. Known documentation and skill-only PRs need
no dependency installation or runtime tests. Typechecking, tooling, and runtime checks
are selected independently; shared contracts exercise both server and PWA tests. Classification
uses the complete PR diff, so a documentation follow-up does not hide earlier
code changes. Unknown paths or unavailable change history select the full gate.
See [verification scope](../../verify/SKILL.md) for tooling-test and browser-case
exceptions. Tooling tests run through `pkg:check`; mixed changes retain all affected
lanes, and unknown test/helper paths default to the full gate.

All workflows use the exact Node version in the workflow checkout's `.nvmrc`, shared
with local verification. Candidate and legacy source checkouts may predate this file;
the workflow revision supplies the pin independently of the reviewed artifact/source.

Release preparation PRs also use the metadata gate when their complete diff changes only
the root and two plugin manifest versions plus optional release notes. CI reads both committed
trees and requires synchronized valid versions with every other manifest field unchanged.
Dependency, script, file-mode, runtime, or other changes retain the ordinary checks. The final
release candidate still runs the full source and packed-install verification.

After scope validation, type/tooling, server, and PWA checks run in separate concurrent jobs.
The required `validate` job aggregates their results and rejects any failure or cancellation.
Static and version-only changes skip the runtime jobs. PWA tests use three shards on separate
runners, preserving the sequential stateful test group. Service-worker checks run on a fourth
runner concurrently with all shards. Each runner builds once; the first browser shard also
runs selected package checks against its own build. Packaging-only scope uses one runner
without browser or service-worker tests. All selected lanes, including all three browser shards
and the service-worker runner, must succeed; an unexpectedly skipped lane fails validation.
Parallel jobs repeat setup and use more runner time to shorten the critical path. Release
candidates retain every source check using the compatible distributed gate below.

Ordinary code PRs do not build or upload a deployment package. Packaging, CLI,
dependency, workflow, and unknown changes add packed-install verification for
trusted PRs, but do not upload a staging artifact. Same-repository checks require
the private-context denylist; fork PRs retain generic source leak checks without
repository secrets or publishable package generation.

New PR revisions cancel superseded PR runs. Keep the required `validate` check
and the rule requiring PRs to be current with their base branch before merge.
Post-merge Preview automation has its own eligibility check and candidate verification.
It does not build a staging deployment package for every merge.

Validation installations follow published Preview releases through the common automatic updater.
There is no staging-only package workflow or deployment command. See
[validation environments](../../../../docs/STAGING.md) for setup and runtime verification.

`release-candidate.yml` is a read-only, commit-based reusable workflow, also available through
manual dispatch on `develop` or `main`. It never creates tags or Releases. The agent can invoke
it on the maintainer's behalf; no Run workflow UI interaction is required.

1. Check out workflow tools separately from the exact 40-character product commit.
2. Verify the version, release notes, and `develop` ancestry for Preview or `main` for Stable.
3. Install frozen dependencies and run the full source gate with the private `LEAK_DENYLIST`
   required. For known source gates, metadata checks and one PWA build precede separate
   type/tooling, server, three browser-shard runners, and an independent service-worker runner.
   Browser runners, service-worker checks, and packaging download the same build artifact from
   this run; its name is retained in preparation outputs so rerunning failed jobs reuses the
   verified build. Every selected lane must succeed before packaging; missing, skipped, failed,
   or cancelled verification blocks it. Unrecognized browser commands or build hooks use the
   complete existing candidate verifier on one runner. Unrecognized source `verify` commands
   or lifecycle hooks retain that source's sequential `pnpm verify`, preserving older and future
   source gates without silently dropping checks.
4. Assemble once from the PWA built and verified in that run, validate the publishable package, pack it,
   install that exact tarball in a scratch project, and boot it.
5. Record `candidate.json`, `SHA256SUMS`, and `RELEASE_NOTES.md` alongside the tarball in
   `palmagent-candidate-<commit>`, retained for 90 days. The manifest binds version, commit,
   channel, filename, SHA-256, repository, and producer run.
6. Present version, commit, channel, checksum, notes, and the validation run in the job summary.

The candidate receives read-only repository/Actions permissions and the leak denylist only;
it has no repository write permission, npm credential, OIDC permission, or host access. A rerun reuses the
original artifact if present. Explicit `candidate_run` recovery must find the immutable artifact
in an approved workflow on `develop`/`main`; an expired/missing artifact is not silently rebuilt.

For a standalone candidate, select the exact prepared commit:

```bash
gh workflow run release-candidate.yml --ref develop -f commit='<full-source-sha>'
```

Use `main` for Stable when the updated workflow is available there. Source and workflow revisions
are distinct: the current `develop` workflow can also verify a Stable source already on `main`.
A candidate build alone does not imply staging acceptance or publication.

Publication records structured phase timings in the Actions log and a table in the job summary.
Candidate validation, registry preflight, tag/assets, npm upload, registry visibility, published
integrity, and public Release creation are measured separately. Failed phases retain their
elapsed time; timings contain no command arguments or error payloads. Timing output failures
cannot change the publication outcome or trigger another upload. Registry polling limits,
immutable-byte verification, and the Stable approval boundary are unchanged.

## Stable App preparation

`stable-prepare.yml` uses the same `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY` as
Preview. It requires the App and has no personal-token or built-in-bot fallback. A maintainer's
Stable request authorizes the agent to dispatch it; a repository workflow update alone is not
an instruction to issue a Stable release.

Review the requested Stable version and `Unreleased` notes first. Empty notes fail closed; add
reviewed notes through a normal PR before preparing. Each phase pins the current `develop` SHA
and refuses drift, existing tags, published versions, or an unrelated preparation PR. Its default
dry-run validates in the disposable checkout without pushing or opening a PR.

```bash
gh workflow run stable-prepare.yml --ref develop \
  -f phase=prepare -f version='<stable-version>' -f commit='<reviewed-develop-sha>' -F dry_run=true
gh workflow run stable-prepare.yml --ref develop \
  -f phase=prepare -f version='<stable-version>' -f commit='<reviewed-develop-sha>' -F dry_run=false
```

The result identifies the App-owned `feature/stable-<version>` PR into `develop`, its source and
head. Wait for native PR CI and reviews, verify its metadata-only diff, and squash-merge the
exact head. The workflow never merges PRs. Then dispatch promotion with the newly reviewed
`develop` head and the same version:

```bash
gh workflow run stable-prepare.yml --ref develop \
  -f phase=promote -f version='<stable-version>' -f commit='<prepared-develop-sha>' -F dry_run=false
```

This opens the dedicated `develop` → `main` PR under the same App. Verify exact-head CI and
reviews before merging with a merge commit. Promotion requires synchronized Stable versions,
versioned notes, and `main` ancestry. It never pushes either long-lived branch directly.

Identical retries retain an open, matching App PR after validating its identity and preparation
tree. A closed/draft/edited PR or changed source requires inspection; no branch is overwritten.
If a branch push succeeded but PR creation failed, retain that branch and inspect it before
recovery. Both phases share the Preview concurrency group so source preparation is serialized.
After promotion, use the existing exact candidate workflow and final `npm-latest` approval.
The App preparation job has no npm credentials or publication step.

## Automatic Preview

`preview-release.yml` runs on `develop` pushes after its setup switch is enabled. It compares
the latest source against the last verified successful Preview; eligibility is implemented in
`scripts/lib/preview-plan.mjs`. It creates only a version/changelog preparation PR, waits for
the native `ci.yml` pull-request run, and merges with the exact head SHA and squash method.
It verifies the workflow, repository, PR event, branch, commit, successful run, and successful
`validate` job. A configured release GitHub App creates PRs whose CI runs automatically. Without
App configuration, GitHub holds `GITHUB_TOKEN`-created PR workflows for maintainer approval.
The controller reports a held run's URL and waits up to 20 minutes for approval and CI completion;
the built-in token fallback is not fully unattended. Branch protections remain in force. If
`develop` advances, it reprepares its own metadata branch with a lease and waits for the new head's CI.
It does not force-push `develop`, bypass review requirements, or merge unrelated PRs.
After updating its own preparation branch, the controller allows up to five one-second polls
for the PR API to replace the known previous head with the pushed head. It never validates or
merges against that stale response; unknown heads, changed PR branches, or a reverted head stop it.
GitHub reads retry transient connection failures and HTTP 429/500/502/503/504 up to three times
with one-, two-, and four-second delays and a 60-second timeout per read. Writes, permission
failures, malformed responses, and integrity mismatches are not retried by this transport layer.

After the preparation merge, the controller creates the annotated Preview tag and dispatches
`npm-publish.yml` with the exact commit. This builds the candidate, publishes through `npm-next`,
and exposes the GitHub prerelease only after npm bytes and `next` are verified. A pending run
checks newer product changes after the current publication completes. The controller resumes
its own merged preparations and tags before allocating another version, preventing metadata
pushes from causing a release loop. A retained draft or open preparation PR remains inspectable.

Concurrency keeps the active Preview and coalesces later pushes into one pending comparison.
Publication jobs also serialize per npm channel and retain pending approvals using `queue: max`.
A candidate older than its current npm channel fails before tag/publication writes; it never
moves a dist-tag backward. See [GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

For an approval-held preparation, inspect the PR's exact source, head, and metadata-only diff.
A maintainer with write access can select **Approve workflows to run** on the PR. In an authorized
release session, the existing maintainer login can submit the reviewed workflow approval:

```bash
gh api --method POST 'repos/<owner>/<repo>/actions/runs/<preparation-ci-run-id>/approve'
```

This is GitHub's workflow-execution approval, not a new Preview publication approval. The
controller continues when that PR run passes. If its wait already expired, or after fixing a
failed run, resume it with:

```bash
gh workflow run preview-release.yml --ref develop
```

No separate version, tag, or publication confirmation is needed within Preview policy. CI
failure, a draft/closed preparation PR, identity mismatch, or unavailable evidence stops the
run; inspect the retained state rather than bypassing it. The first enabled run can include
all eligible product changes since the last successful Preview, not just the enabling commit.

## Protected npm publication

`npm-publish.yml` takes one exact `commit`, invokes the candidate workflow, then selects its
channel environment. `npm-next` has no reviewer gate. `npm-latest` is the single Stable human
approval, after the exact candidate and checks are available and before any Stable tag, npm
publication, or public Release is created. The maintainer reviews compatibility and acceptance
evidence alongside the candidate summary. Do not add a second conversational approval.

```bash
gh workflow run npm-publish.yml --ref develop -f commit='<prepared-channel-source-sha>'
# Reuse previously inspected candidate bytes, including for Stable acceptance:
gh workflow run npm-publish.yml --ref develop -f commit='<prepared-channel-source-sha>' -f candidate_run='<producer-run-id>'
```

The final job downloads those exact bytes and revalidates the source, checksum, package identity,
and environment policy. It then creates or verifies the annotated tag, creates or resumes the
draft with immutable assets, publishes via npm OIDC/provenance, downloads and verifies registry
bytes and the intended dist-tag, and makes the GitHub Release public last. Stable tagging takes
place only inside this job after approval. No rebuild or npm token is used.

`release.json` adds the annotated tag object to the candidate's version, commit, branch, channel,
filename, SHA-256, and validation run URL. It is traceability metadata, not itself a cryptographic
attestation or proof of npm publication. Check the registry's version, SHA-512 integrity,
downloaded tarball SHA-256, and channel separately. Partial drafts may fill only missing assets;
existing assets and tags must match exactly, and published assets are never overwritten.

### One-time setup

1. For release PR automation, register a private GitHub App owned by the repository owner and install
   it only on this repository. Use the repository URL as its homepage, disable webhooks, and grant
   repository **Contents**, **Pull requests**, and **Actions** read/write; Metadata read is automatic.
   No organization permissions, user authorization callback, or branch/ruleset bypass is required.
   Generate a private key, store it directly as Actions secret `RELEASE_APP_PRIVATE_KEY`, and then
   set Actions variable `RELEASE_APP_CLIENT_ID` to the App's Client ID. Do not paste the key into
   chat or commit it. `actions/create-github-app-token@v3` creates a short-lived token for the current
   repository with those explicit permissions and revokes it after the job. Its App slug determines
   the commit/PR bot identity. Missing key, installation, or permissions fails the job; a configured
   App never silently falls back to the built-in bot. Finish any pending preparation/release before
   switching identities. See [GitHub App token setup](https://github.com/actions/create-github-app-token).
   Without the Client ID, the workflow retains the supervised built-in token mode; that mode needs
   **Allow GitHub Actions to create and approve pull requests** enabled in Actions settings.
   Keep default workflow permissions read-only. Preview declares Contents, Pull requests, and
   Actions write for the fallback. The protected publication job retains its built-in token with
   Contents write, Actions read, and OIDC write; it does not receive the App private key.
2. Permit creation of new `v*` tags by repository writers: disable the separate tag-creation
   restriction if present. Keep the tag update/deletion prohibition active with no bypass, and
   preserve branch protections. This permits writers to create new release tags; it does not
   grant automatic publication to arbitrary tags or permit changing an existing tag.
3. Keep `npm-next` without reviewers or a wait timer; keep `npm-latest` with a required reviewer,
   no administrator bypass, and self-review allowed for a sole maintainer. Allow the intended
   `develop`/`main` workflow refs (and `v*` only if legacy retries need them).
4. Configure npm Trusted Publishers for repository workflow `npm-publish.yml` and each channel
   environment. Keep `NPM_PUBLISH_ENABLED=true` only with verified trust bindings. The workflow
   uses Node 24 and npm 11.11.1. See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/).
5. Make the workflows available on the repository default branch for dispatch through its normal
   reviewed PR path. Confirm source eligibility, App installation (or fallback Actions PR permission),
   tag rules, and channel environments before setting `PREVIEW_RELEASE_ENABLED=true`. Enabling is standing authorization
   to publish eligible Preview changes; installation updates follow saved preferences
   or an operator request.

The built-in token does not provide ordinary push-triggered workflow chaining. The controller
explicitly dispatches publication and queues another Preview comparison when product changes
remain. It uses the native PR CI run for preparation checks. A separate `workflow_dispatch` run
on the same commit can succeed while the held PR still reports its required check as expected;
do not use that run as a substitute for the maintainer-approved PR workflow. See
[workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
and [bot-created PR approvals](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/).
Until the Preview switch is enabled, the controller job is skipped. App-created PRs trigger native
CI without the built-in token's approval hold. Verify the first eligible product change through
preparation PR CI, squash merge, publication run, public Release, and npm `next`; merely configuring
the App or a successful no-change run does not prove unattended publication. Do not self-approve
held workflows with the bot token or copy a maintainer credential into Actions.

### Recovery

Inspect Actions runs, tags, drafts, release assets, and npm before retrying. An interrupted upload
or failed post-upload verification can leave the immutable npm version published. After a successful
upload, verification retries missing version metadata at five-second intervals, up to 60 retries (five minutes). Release metadata reads use a unique validation URL to avoid
cached pre-upload responses; upstream propagation can still take several minutes.
A reported integrity mismatch or registry lookup error stops immediately. Retry with the same source and `candidate_run`;
identical registry bytes skip npm upload, and the job verifies the channel before exposing the
Release. Automatic Preview searches earlier recovery runs for the original producer artifact.
Changed or expired evidence requires deliberate recovery; do not silently rebuild reviewed bytes.

Legacy already-public releases can still be retried with `-f tag='v<version>'`, omitting `commit`.
This path uses the original release assets and tagged validation code, retains channel gates,
and never creates a new tag or Release. Tag pushes and manually publishing a Release no longer
start the new release train. Older immutable workflow revisions can retain their historical
behavior; use the current branch workflow for the new policy.

```bash
npm view palmagent dist-tags --json
npm view palmagent@<version> dist.integrity
```

Deprecation and dist-tag correction require a separate request. Issue a new version for changed
source or bad published bytes; never overwrite a version or move a release tag. If a failed Preview
needs a source fix, pause the Preview switch and let active runs finish. Prepare an unused version
on fixed `develop` through a verified PR, then dispatch `npm-publish.yml` for that exact commit.
Keep the failed tag/candidate evidence. After successful publication establishes the new baseline,
restore the switch. This is recovery within Preview authorization, not a parallel release train;
ordinary retries intentionally resume the older pending preparation first. Installation failures
use the ordinary update/doctor recovery flow; retain its receipts and previous releases. Package recovery does not restore the database.

## Release checklist

Candidate CI verifies source, private and generic leak checks, synchronized product versions,
package contents, packed install, SQLite runtime, and PWA boot. Check its exact commit, checksum,
notes, and producer run. Keep compatibility and required upgrade steps in the release notes.
No Stable tag should exist before its final approval; verify tag identity afterward.

For Stable, also complete applicable clean-host install, update from the previous Stable,
database backup/quick-check, passkey login, HTTPS, SSE reconnect, and rollback acceptance on the
exact candidate. Record live checks and their limitations with the candidate's review evidence;
hermetic CI does not prove them. A first Stable release has no previous Stable to upgrade from.
Repository visibility remains separately authorized. Installed versions and health must
be verified independently of publication, whether updates are automatic or requested.
