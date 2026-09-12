## Summary

<!-- What changed and why? -->

## Verification

<!-- List the commands and runtime evidence. -->

## Public import review

Complete this section when content came from a non-public source. Otherwise mark it not applicable.

- [ ] Every imported file is listed or clearly bounded in this PR.
- [ ] Code, comments, examples, fixtures, and metadata were reviewed file by file.
- [ ] Repository/package identities and stale cross-file references were replaced.
- [ ] Personal context, private infrastructure, credentials, transcripts, and runtime data were removed.
- [ ] Lockfiles and generated artifacts were regenerated instead of copied.
- [ ] Generic leak checks and the private context denylist passed.
- [ ] Any intentionally byte-identical files are identified in the PR description.

## Delivery boundaries

- [ ] Version changes have prior explicit human approval recorded here, or this PR does not change versions.
<!-- For version changes, link or summarize the approval of the proposed version and release scope. -->
- [ ] Delivery follows [ship](../.harness/skills/ship/SKILL.md): verified task PRs into `develop`
  squash-merge automatically unless the user requests PR-only delivery, a draft, or a merge hold.
  After merge, the task's worktree and local branch are removed when cleanup checks pass,
  unless the user requests retention; any retained resources are reported with a reason.
- [ ] Merges into `main`, version changes, tags, publication, repository visibility changes, and
  host deployment retain their separate approvals under [release policy](../.harness/skills/release/references/policy.md#branch-and-approval-flow).
