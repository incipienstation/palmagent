---
name: release
description: Prepare, resume, publish, or recover a Palmagent prerelease or stable release using existing release automation and verified artifacts. Use for maintainer release work; installed-user updates belong to the operator update skill.
---

# Release Palmagent

Use this workflow to carry a release from its current verified phase to the requested
outcome. The [release contract](../../../docs/RELEASING.md) owns version, channel, approval,
and recovery policy. Read the linked sections as needed; use the existing scripts and CI
instead of recreating packaging or publishing logic.

## Establish the current phase

Inspect the requested version, root/plugin manifests, changelog, source branch and commit,
remote tag, matching workflow runs, GitHub Release (including drafts), and npm version/tag
metadata as relevant. Distinguish prepared source, tagged candidate, reviewed draft, registry
publication, and host deployment. Resume from current evidence rather than repeating steps
from an earlier conversation or report. A registry error does not prove a version is absent.

Carry forward explicit approval for the same action and target. Before any unapproved
version edit, tag, publication, or deployment, finish its read-only preparation and present
the concrete target, impact, and evidence. Approval for one phase does not authorize the
others; publishing a prerelease Release specifically authorizes its automatic npm publication.
An inspection or proposal request stops before mutation.

## Prepare the source

Follow [version policy](../../../docs/RELEASING.md#version-policy) and the
[approval flow](../../../docs/RELEASING.md#branch-and-approval-flow). Present the current and
proposed version, scope, compatibility impact, changelog, and validation evidence. Preview
with `pnpm release:prepare <version>`; add `--apply` only for the explicitly approved version.
Do not infer approval for a version bump from a general request to continue.

Use [start](../start/SKILL.md), [verify](../verify/SKILL.md), and [ship](../ship/SKILL.md) for
the preparation PR into `develop`. Stable promotion additionally needs its separately
approved merge-commit PR into `main`. Resolve the resulting commit before requesting tag
approval. For an already prepared release, verify its source instead of preparing it again.

## Tag and inspect the candidate

Follow [candidate automation](../../../docs/RELEASING.md#candidate-automation). Check the
approved exact commit and channel ancestry, then create and push only its annotated
`v<version>` tag. If the remote tag already exists, verify its object and target; never move
it to incorporate a fix. Track `release-candidate.yml` for that exact tag and commit.

After CI succeeds, download the draft's tarball, `SHA256SUMS`, and `release.json`. Match the
tag object, source commit, version, channel, and package checksum to the successful run;
inspect packaged build identity and the release notes. Retain the verified bytes for the
publication proposal. Use CI's source, leak, and packed-install evidence; a local rebuild
does not replace that artifact. Report missing or failed evidence before proceeding.

For stable releases, complete the [release checklist](../../../docs/RELEASING.md#release-checklist)
on this candidate before publication. Hand approved staging work to
[staging-deploy](../staging-deploy/SKILL.md). A rebuilt stable package needs its own acceptance.

## Publish and verify

Present the reviewed draft, exact version/commit/checksum, checks, and intended npm channel.
With publication approval, publish that GitHub Release and follow `npm-publish.yml` through
completion. Prereleases use `npm-next` automatically; stable releases also need the
`npm-latest` reviewer. Follow [publication policy](../../../docs/RELEASING.md#protected-npm-publication);
never run workstation `npm publish` or rebuild the package for publication.

Check the registry's exact version and intended dist-tag, download its tarball, and verify
its SHA-512 integrity and SHA-256 against the reviewed package. GitHub publication or a
green workflow alone is not the final registry evidence. Report version, source commit,
release/run URLs, checksum, and channel; hand off any authorized deployment separately.

## Recovery and acceptance evidence

Inspect a failed run and any partial draft or published registry version before retrying.
Use the [recovery rules](../../../docs/RELEASING.md#protected-npm-publication): identical bytes
may allow a workflow retry; changed source requires a newly approved version and tag.
Do not replace release assets, move tags, or bypass environment protection to recover.

For requested plugin or clean-install acceptance, test the exact published tag/package
through native plugin managers in isolation. Verify installed manifests separately from
runtime health. State whether the test exercised scripted commands, an authenticated agent
conversation, or a full fresh-host service/TLS install; do not substitute one for another.

Keep release-specific receipts and private host details outside committed source. Record
completed phases, remaining approvals, artifact identity, and test limits so a later run
can revalidate and resume. Reusable procedure belongs here; individual release history does
not. Do not advance the next development version or deploy another host as implicit cleanup.
