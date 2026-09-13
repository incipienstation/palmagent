# Release automation and verification

## Candidate automation

Ordinary CI runs only on pull requests into `develop` or `main`, not on branch pushes after merge.
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

New PR revisions cancel superseded PR runs. Keep the required `validate` check
and the rule requiring PRs to be current with their base branch before merge.
Post-merge Preview automation has its own eligibility check and candidate verification.
It does not build a staging deployment package for every merge.

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

`release-candidate.yml` is a read-only, commit-based reusable workflow, also available through
manual dispatch on `develop` or `main`. It never creates tags or Releases. The agent can invoke
it on the maintainer's behalf; no Run workflow UI interaction is required.

1. Check out workflow tools separately from the exact 40-character product commit.
2. Verify the version, release notes, and `develop` ancestry for Preview or `main` for Stable.
3. Install frozen dependencies and run `pnpm verify` with the private `LEAK_DENYLIST` required.
4. Assemble once from the PWA built in that run, validate the publishable package, pack it,
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

## Automatic Preview

`preview-release.yml` runs on `develop` pushes after its setup switch is enabled. It compares
the latest source against the last verified successful Preview; eligibility is implemented in
`scripts/lib/preview-plan.mjs`. It creates only a version/changelog preparation PR, waits for
the native `ci.yml` pull-request run, and merges with the exact head SHA and squash method.
It verifies the workflow, repository, PR event, branch, commit, successful run, and successful
`validate` job. GitHub holds workflows on `GITHUB_TOKEN`-created PRs for maintainer approval.
The controller reports the run URL and waits up to 20 minutes for approval and CI completion;
this setup is not fully unattended. Branch protections remain in force. If `develop` advances,
it reprepares its own metadata branch with a lease and waits for the new head's CI.
It does not force-push `develop`, bypass review requirements, or merge unrelated PRs.

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

1. In repository Actions settings, enable **Allow GitHub Actions to create and approve pull
   requests**. Keep default workflow permissions read-only. Preview declares only Contents,
   Pull requests, and Actions write; the protected publication job declares Contents write,
   Actions read, and OIDC write. No GitHub App registration or stored release token is needed.
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
   reviewed PR path. Confirm source eligibility, Actions PR permission, tag rules, and channel
   environments before setting `PREVIEW_RELEASE_ENABLED=true`. Enabling is standing authorization
   to publish eligible Preview changes; it does not authorize host deployment.

The built-in token does not provide ordinary push-triggered workflow chaining. The controller
explicitly dispatches publication and queues another Preview comparison when product changes
remain. It uses the native PR CI run for preparation checks. A separate `workflow_dispatch` run
on the same commit can succeed while the held PR still reports its required check as expected;
do not use that run as a substitute for the maintainer-approved PR workflow. See
[workflow triggering](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
and [bot-created PR approvals](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/).
Until the Preview switch is enabled, the controller job is skipped. Fully unattended PR CI
requires a separately authorized credential design; do not self-approve held workflows with the
bot token or copy a maintainer credential into Actions.

### Recovery

Inspect Actions runs, tags, drafts, release assets, and npm before retrying. A failed upload can
already have published the immutable npm version. Retry with the same source and `candidate_run`;
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
ordinary retries intentionally resume the older pending preparation first. Host rollback is
separate; see [staging rollback](../../../../docs/STAGING.md#rollback-and-failures).

## Release checklist

Candidate CI verifies source, private and generic leak checks, synchronized product versions,
package contents, packed install, SQLite runtime, and PWA boot. Check its exact commit, checksum,
notes, and producer run. Keep compatibility and required upgrade steps in the release notes.
No Stable tag should exist before its final approval; verify tag identity afterward.

For Stable, also complete applicable clean-host install, update from the previous Stable,
database backup/quick-check, passkey login, HTTPS, SSE reconnect, and rollback acceptance on the
exact candidate. Record live checks and their limitations with the candidate's review evidence;
hermetic CI does not prove them. A first Stable release has no previous Stable to upgrade from.
Repository visibility and host deployment remain separately authorized and verified.
