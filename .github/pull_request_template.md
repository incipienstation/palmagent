## Summary

<!-- What changed and why? -->

## Verification

<!-- List the commands and runtime evidence. -->

## Delivery boundaries

- [ ] Version changes follow [release policy](../.harness/skills/release/references/policy.md#branch-and-approval-flow), or this PR does not change versions.
<!-- State the Preview lane or requested Stable release scope when versions change. -->
- [ ] Delivery follows [ship](../.harness/skills/ship/SKILL.md): verified task PRs into `develop`
  squash-merge automatically unless the user requests PR-only delivery, a draft, or a merge hold.
  After merge, the task's worktree and local branch are removed when cleanup checks pass,
  unless the user requests retention; any retained resources are reported with a reason.
- [ ] Product changes on `develop` may publish Preview automatically. Stable publication waits
  for approval of its exact candidate; repository visibility and host deployment remain separate.
