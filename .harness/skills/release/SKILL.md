---
name: release
description: Prepare, resume, publish, or recover a Palmagent prerelease or stable release using existing release automation and verified artifacts. Use for maintainer release work; installed-user updates belong to the operator update skill.
---

# Release Palmagent

Carry a release from its current verified phase to the requested outcome. This skill owns
both the execution workflow and its supporting contracts. Read only the relevant reference:

| Work | Reference |
| --- | --- |
| Version proposals, changelog, branch promotion, or approval boundaries | [Release policy](references/policy.md) |
| CI candidates, tag creation, publication setup, verification, or recovery | [Automation](references/automation.md) |
| Stable/Preview, shared settings, compatibility, or installed-user update behavior | [Channels and updates](references/channels-and-updates.md) |

Use the existing repository scripts and workflows. Run commands from the repository root.

## Resume from evidence

Inspect the requested version, manifests, changelog, source commit, remote tag, matching
workflow runs, GitHub Release (including drafts), and npm metadata as relevant. Distinguish
prepared source, tagged candidate, reviewed draft, registry publication, and host deployment.
Resume from live evidence; an earlier report or a registry error does not establish current state.

Carry forward explicit approval for the same action and target. Before an unapproved action,
finish its read-only preparation and present the concrete target, impact, and evidence under
[the approval flow](references/policy.md#branch-and-approval-flow). An inspection or proposal
request stops before mutation. Keep completed phases, remaining approvals, artifact identity,
and test limits in release-specific records outside committed source and this reusable skill.

## Prepare and tag

Present the version proposal with scope, compatibility impact, changelog, and validation
using [release policy](references/policy.md). Preview `pnpm release:prepare <version>`;
apply only the approved version. Use [start](../start/SKILL.md), [verify](../verify/SKILL.md),
and [ship](../ship/SKILL.md) for the preparation PR. Resolve the final channel-source commit
before tag approval. Verify already prepared source rather than preparing it again.

Follow [candidate automation](references/automation.md#candidate-automation) for the exact
approved annotated tag. Verify any existing tag's object and target instead of recreating it.
Track `release-candidate.yml` for that tag/commit. Inspect the draft tarball, `SHA256SUMS`,
`release.json`, packaged build identity, and release notes against the successful run.
Retain those bytes and CI's source/leak/packed-install evidence for publication review;
a local rebuild does not replace the candidate. Resolve missing or failed evidence first.

For stable releases, complete the [release checklist](references/automation.md#release-checklist)
on that candidate before publication. Hand approved staging work to
[staging-deploy](../staging-deploy/SKILL.md); a rebuilt stable package needs its own acceptance.

## Publish or recover

Present the reviewed draft, exact version/commit/checksum, checks, and npm channel. With
publication approval, publish that GitHub Release and follow `npm-publish.yml` through
completion under [publication policy](references/automation.md#protected-npm-publication).
Then check the registry's exact version and intended dist-tag, download its tarball, and
verify its SHA-512 integrity and SHA-256 against the reviewed package. Report the release/run
URLs and verified identity; hand off authorized deployment separately.

On failure, inspect the run and any partial draft or registry publication before applying
[the recovery rules](references/automation.md#protected-npm-publication). Keep the exact
reviewed bytes and tag immutable; changed source requires a newly approved version/tag.
Do not advance the next development version or deploy another host as implicit cleanup.

For requested plugin or clean-install acceptance, use native managers with the exact
published tag/package in isolation and verify installed manifests separately from runtime
health. State whether the test exercised scripted commands, an authenticated agent
conversation, or a full fresh-host service/TLS install; do not substitute one for another.
