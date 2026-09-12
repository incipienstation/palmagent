---
name: ship
description: Final stage of Palmagent's plan → start → verify → ship loop. Automatically squash-merge verified task pull requests into develop, then finish authorized worktree cleanup. Use when finishing a task or completing post-merge cleanup.
---

# Ship

1. Review the complete task diff and commit it with a clear message.
2. Push the `feature/*` branch and open a PR with **base = `develop`** (never `main` directly).
3. For the task's non-draft PR into `develop`, wait for required CI checks on its current head
   to pass and for repository review requirements to be satisfied, then squash-merge automatically.
   No additional human confirmation is needed unless the user requested a draft, PR-only delivery,
   or an explicit merge hold. Confirm the PR base and head immediately before merging; use
   `gh pr merge <pr-number> --squash --match-head-commit <verified-head-sha>`. If the head or base
   changes, update and reverify as needed. Resolve task-owned conflicts before merging; never
   bypass failing checks, unresolved reviews, or branch protections with `--admin`.
4. Report the merged commit and validation evidence. Merges into `main` still require explicit
   human approval and use a merge commit through a dedicated PR. Versioning, tagging, publication,
   visibility changes, and deployment retain their separate approval rules in the
   [release runbook](../../../docs/RELEASING.md); automatic `develop` merge does not authorize them.
   When release work is requested, continue through [release](../release/SKILL.md).
5. Keep the worktree while the PR is open or implementation/review is still active. After merge,
   complete the cleanup below and report anything retained with its reason.

## Post-merge worktree cleanup

Identify the exact task-owned worktree and local branch with `git worktree list --porcelain`.
Verify the PR is merged into its intended base and the local branch matches the merged PR head,
with no later commits. Check tracked, untracked, and ignored files for work or local data that
removal would discard. A clean `git status` alone does not account for ignored files, and squash
merges do not preserve the feature head as an ancestor of the base branch.

Use cleanup authorization already given for these resources; do not ask again. If it is absent,
present the exact worktree and local branches for approval before deleting them. Preserve the
main checkout, other tasks' worktrees, and any resource whose ownership or contents are uncertain.

Select the exit/removal procedure by the running environment and how the worktree was created,
not by the presence of `.agents` or `.claude` directories:

- **Claude Code-managed worktree:** use the native `ExitWorktree` tool when available to leave
  the worktree and apply the authorized keep/remove choice. Verify the result before attempting
  any separate Git cleanup; do not externally delete a worktree still bound to the session.
- **Codex app-managed worktree:** use the app's handoff and worktree lifecycle controls to leave
  and remove it within the approved scope. If those controls are unavailable, retain it and
  report the remaining action; do not delete the active app-managed directory externally.
- **Manually created Git worktree, including Codex CLI work:** move subsequent command working
  directories and edit targets outside it. A shell `cd` does not establish that the agent session
  has moved. Once no session, task-owned process, or pending tool call still uses it, run
  `git worktree remove <worktree-path>` from a retained checkout, without `--force`.

Remove an approved task-local branch with `git branch -d <branch>` only after its worktree is
removed. If Git refuses, including after a squash merge, retain the branch and explain why;
do not silently escalate to `-D`. Remote branch deletion is a separate action. Avoid blanket
worktree pruning or directory deletion to clear an error.

Recheck the worktree registry, removed path, and local branch refs. Report what was actually
removed and what remains; PR delivery, merge, and cleanup are distinct completion states.
