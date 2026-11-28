---
name: ship
description: Merge a verified Palmagent task PR into develop, update local develop, and clean up its worktree.
---

# Ship

Authorized implementation includes squash merge into `develop`, updating local `develop`, and
safe task cleanup. Honor draft, PR-only, merge-hold, and retention requests. `main` merges,
merge-policy changes, and repository visibility changes use [release](../release/SKILL.md).

Commit and push the task branch, preserving intended author and committer identities. Open a PR
into `develop`. Once the task is ready to merge, local-only verification is complete, and
applicable reviews pass, enqueue the PR and its verified head. Resolve known CI failures
first. The worker follows any running CI for the selected head.
The worker shares its turn with Preview preparation, updates the branch when necessary, and
waits for CI on the resulting head before requesting a protected squash merge. For local
evidence tied to the base commit, pass that SHA as the third argument. Always pin the base
for Stable preparations and compatibility promotions.

```bash
node scripts/queue-develop.mjs <number> <verified-head-sha>
```

Follow the returned Actions run if interrupted. A conflict or changed head requires review
of the affected changes before a new request. Confirm the merged PR head and merge commit.
If the queue updated the task branch, fetch the PR head ref and fast-forward the clean
task worktree to the confirmed merged PR head before running cleanup.

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

A passive shell, agent, or Codex tool host holding only the primary checkout's cwd does not
block its fast-forward. File, executable, and argument references still block it, as do other
processes using that cwd. Any observable process use retains a task worktree slated for deletion.
For another process reported as using the cwd, inspect its command and role. If it is an unrelated
passive tool, rerun with `--passive-primary-pid <pid>` (repeatable). This permits only that cwd
reference during primary updates; file, executable and argument checks still apply. An external
executable alone does not prove passivity. Keep servers, builds, tests and uncertain processes blocked.

For Claude Code- or Codex app-managed worktrees, use the native lifecycle controls instead of
external deletion. Unknown ignored files, private data, or active task sessions require retention;
remove identified reproducible output only when safe. Report remaining cleanup without forcing it.
