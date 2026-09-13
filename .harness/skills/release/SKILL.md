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

Carry forward the requested release scope and existing authorization under
[release policy](references/policy.md#branch-and-approval-flow). Preview has standing automatic
publication authorization for eligible `develop` changes. A Stable request authorizes preparation
through the exact candidate; the single final `npm-latest` approval precedes irreversible actions.
An inspection or proposal request stops before mutation. Keep release evidence outside this skill.

## Prepare and publish

For Preview, inspect or resume `preview-release.yml` using
[automatic Preview](references/automation.md#automatic-preview). It owns version allocation,
metadata PRs, tagging, and publication; do not race it with manual version edits or publication.
If setup is incomplete, finish the reviewable code and identify the missing configuration.
Use the built-in `GITHUB_TOKEN` and the documented explicit CI dispatch. Do not substitute a
personal token or bypass branch checks and existing-tag protections.

For a requested Stable release, select a version from scope and compatibility, preview and apply
`pnpm release:prepare <version>`, and use [start](../start/SKILL.md), [verify](../verify/SKILL.md),
and [ship](../ship/SKILL.md) for its preparation PR. Promote through a dedicated PR into `main`
with a merge commit after required checks. Version edits and this promotion are preparation;
do not request separate publication approvals for them.

Build the exact final source with [candidate automation](references/automation.md#candidate-automation).
Inspect the tarball, `candidate.json`, `SHA256SUMS`, packaged identity, notes, and producer run.
Complete applicable [Stable acceptance](references/automation.md#release-checklist) on those bytes,
handing authorized host work to [staging-deploy](../staging-deploy/SKILL.md). Present version,
commit, checksum, scope, compatibility impact, checks, and limits in the approval evidence.
Dispatch `npm-publish.yml` with the exact commit and candidate producer run; wait for its single
`npm-latest` reviewer approval. Do not create a Stable tag or publish a Release before this gate.

Follow the publication run through completion. Verify the registry's exact version and intended
dist-tag, then download the tarball and check SHA-512 integrity and SHA-256 against the candidate.
Report release/run URLs and verified identity. Host deployment remains a separate requested action.

## Recover

On failure, inspect partial publication before applying
[recovery rules](references/automation.md#recovery). Preserve the original candidate bytes and
reuse their producer run. Never overwrite assets, move an immutable tag, or republish changed
bytes at the same version. A new Stable candidate needs a new approval. Preview retries within
policy need no additional confirmation; identity conflicts or missing evidence must be resolved.

For requested plugin or clean-install acceptance, use native managers with the exact published
package/tag in isolation and verify installed manifests separately from runtime health. State
whether evidence covers scripted commands, an authenticated agent conversation, or fresh-host
service/TLS installation; those are distinct tests.
