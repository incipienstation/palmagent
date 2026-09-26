---
name: ship
description: Final stage of Palmagent's plan → start → verify → ship loop. Automatically squash-merge verified task pull requests into develop, update local develop, and clean up the completed task's verified worktree.
---

# Ship

1. Review the complete diff and commit with a clear message. Preserve intended author and committer
   identities; inspect `%ae` and `%ce` across the new commit range.
2. Push the `feature/*` branch and open a PR into `develop` (never directly into `main`).
3. Watch required checks in one CLI session with
   `gh pr checks <number> --required --watch --fail-fast --interval 30`; wait on the same process at
   60-second intervals or longer and report status changes. Inspect job logs when checks fail.
   Reuse evidence only while inputs are unchanged; if the head or base changes, update and reverify.
   Resolve task-owned conflicts. After checks and review requirements pass, squash-merge unless the
   user requested draft, PR-only, or merge hold. Confirm base and head immediately before merging;
   use `gh pr merge <number> --squash --match-head-commit <verified-head-sha>`. Verify the merged
   commit identity and metadata. Never bypass failed checks, unresolved reviews, or protections with
   `--admin`.
4. Report the merge commit and validation evidence. Follow
   [release policy](../release/references/policy.md#branch-and-approval-flow) for Preview and Stable.
   Do not require a staging deployment after a merge. Visibility remains a separate approval.
5. Keep the worktree while implementation or review is active. After merge, update local `develop`
   and clean up the task worktree and branch using the checks below.

## Update local develop after merge

Fetch `origin/develop` and identify the primary checkout with `git worktree list --porcelain`. Update
it only if it already has `develop` checked out, has no tracked or untracked changes, and no Git
operation is in progress. Do not switch branches or update another task's worktree.

An open process whose working directory is the primary checkout is not by itself a reason to skip.
Skip only with concrete evidence of an active edit, build, test, or server loading source from that
checkout. If safe, confirm local `develop` is an ancestor of or equal to `origin/develop`, then run
`git -C <primary-checkout> merge --ff-only origin/develop`. Never stash, reset, rebase, create a
merge commit, or discard files to force the update.

Verify local `develop` equals fetched `origin/develop` and includes the PR merge commit. Report its
final SHA and whether the update succeeded, was already current, or was skipped with a reason. On
fetch or safety-check failure, preserve the checkout and continue independent cleanup.

## Clean up the task worktree after merge

Identify the exact task-owned worktree and branch. Confirm the PR is merged into its intended base
and the local branch matches the merged PR head with no later commits. Inspect tracked, untracked,
and ignored files; a clean `git status` does not account for ignored data.

Remove only the merged source and identified reproducible task output. Preserve any worktree with
later commits, uncommitted work, private data, uncertain ignored files, or an active session or
process. Do not switch or remove the primary checkout or another task's worktree. Report anything
retained and ask only when resolving it needs a new decision.

Use the exit procedure for the environment that created the worktree:

- **Claude Code-managed:** use native `ExitWorktree` when available and verify the result before Git
  cleanup; do not externally delete a directory still bound to the session.
- **Codex app-managed:** use the app's lifecycle controls. If unavailable, retain the worktree and
  report the remaining action; do not delete it externally.
- **Manually created Git worktree, including Codex CLI:** move command and edit targets outside it,
  then ensure no session, task process, or pending tool call still uses it. Run
  `git worktree remove <path>` without `--force`.

After removing the worktree, remove its local branch with `git branch -d <branch>`. If Git refuses,
including after a squash merge, retain the branch; never escalate to `-D`. Remote branch deletion is
separate. Recheck the registry, path, and branch refs, and report exactly what was removed or
retained.
