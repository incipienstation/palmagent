---
name: ship
description: Merge a verified Palmagent task PR into develop, update local develop, and clean up its worktree.
---

# Ship

Authorized implementation includes squash merge into `develop`, updating local `develop`, and
safe task cleanup. Honor draft, PR-only, merge-hold, and retention requests. `main` merges,
merge-policy changes, and repository visibility changes use [release](../release/SKILL.md).

Commit and push the task branch, preserving intended author and committer identities. Open a PR
into `develop`. Watch checks in one session:

```bash
gh pr checks <number> --watch --fail-fast --interval 30
```

Follow [Waiting for checks](../verify/SKILL.md#waiting-for-checks). Reverify affected checks if the
head or base changes. Once checks and reviews pass, confirm the base and merge the verified head:

```bash
gh pr merge <number> --squash --match-head-commit <verified-head-sha>
```

Never bypass protections with `--admin`. Report the merge identity and validation evidence.
Ordinary delivery ends with merge and cleanup; CI/CD handles Preview. Load Release or check a host
only when publication intervention or host verification is requested.

## Local cleanup

From outside the task worktree, run:

```bash
node scripts/finish-task.mjs --pr <number> --worktree <absolute-task-path>
```

The helper previews Git safety checks. After releasing task sessions and pending tools, add
`--apply` for a manual `.harness/worktrees/` worktree. It refreshes and fast-forwards a clean primary
`develop`, removes only a clean merged task worktree with no ignored files or observable process use,
and deletes the local branch only while its ref exactly matches the merged PR head and the PR merge
commit is in `origin/develop`. This covers squash merges without relying on branch ancestry. The
same command can finish branch cleanup after the worktree is gone. Changed or checked-out branches
are retained; the expected commit is checked atomically during deletion.

For Claude Code- or Codex app-managed worktrees, use the native lifecycle controls instead of
external deletion. Unknown ignored files, private data, or active sessions require retention;
remove identified reproducible output only when safe. Report remaining cleanup without forcing it.
