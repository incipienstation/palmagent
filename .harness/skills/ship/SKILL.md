---
name: ship
description: Final stage of Palmagent's plan → start → verify → ship loop. Automatically squash-merge verified task pull requests into develop, safely update local develop, and clean up the completed task's verified worktree and local branch. Use when finishing a task or completing post-merge cleanup.
---

# Ship

1. Review the complete task diff and commit it with a clear message. Resolve the maintainer's
   approved public noreply email first. Set it for both author and committer when committing,
   amending, or rebasing; rebases can restore a private default committer email. Inspect both
   `%ae` and `%ce` on the complete new commit range before pushing.
2. Push the `feature/*` branch and open a PR with **base = `develop`** (never `main` directly).
3. For the task's non-draft PR into `develop`, wait for required CI checks on its current head
   to pass and for repository review requirements to be satisfied, then squash-merge automatically.
   No additional human confirmation is needed unless the user requested a draft, PR-only delivery,
   or an explicit merge hold. Confirm the PR base and head immediately before merging; use
   `gh pr merge <pr-number> --squash --match-head-commit <verified-head-sha> --author-email <public-noreply-email>`.
   GitHub can otherwise select the account's default email for the squash author. Verify the
   merged commit's author/committer addresses too. While waiting, use a CLI watch or bounded polling
   with concise status output; inspect job logs when checks fail. Reuse collected evidence while
   its inputs remain unchanged, and retain the final base/head check above. If the head or base
   changes, update and reverify as needed. Resolve task-owned conflicts before merging; never
   bypass failing checks, unresolved reviews, or branch protections with `--admin`.
4. Report the merged commit and validation evidence. Follow the
   [release policy](../release/references/policy.md#branch-and-approval-flow) for release work:
   product changes on `develop` can trigger automatic Preview publication; a requested Stable
   release includes its dedicated `main` promotion PR with a merge commit and required checks.
   Other `main` merges require explicit approval. Stable tagging/publication wait for the final
   candidate approval. Visibility and host deployment remain separate.
5. Keep the worktree while the PR is open or implementation/review is still active. After merge,
   complete the local develop update and cleanup below, reporting any skipped action with its reason.

## Post-merge local develop update

After confirming the PR is merged into `develop`, run `git fetch origin develop`. Identify the
primary checkout with `git worktree list --porcelain` and update it only when it already has
`develop` checked out and has no tracked or untracked changes or Git operation in progress.
Do not switch branches or update other tasks' worktrees to perform this step.

When implementation is isolated in linked worktrees, proceed with the primary checkout's
fast-forward without additional confirmation. An open shell or agent process whose working
directory is the primary checkout is not, by itself, a reason to skip: updating `develop`
does not change another worktree's checked-out branch or files. Skip for a process dependency
only when there is concrete evidence that work uses the primary checkout's current files,
such as an active edit, build, test, or server loading source from that checkout. State that
dependency when reporting a skipped update; do not infer it from a process's working directory
alone. This distinction applies to updating `develop`, not removing an active worktree.

Confirm local `develop` is an ancestor of the fetched `origin/develop` (or already equal), then
run `git -C <primary-checkout> merge --ff-only origin/develop`. Do not stash, reset, rebase,
create a merge commit, or discard files to make the update succeed. If fetching fails or any
condition is unmet, preserve the checkout and report the reason; continue independently safe
task cleanup below.

Verify local `develop` equals the fetched `origin/develop` and includes the PR's merge commit.
Report the final local SHA and whether the update succeeded, was already current, or was
skipped. This updates `develop` only; `main` and feature branches are outside this step.

## Post-merge worktree cleanup

Identify the exact task-owned worktree and local branch with `git worktree list --porcelain`.
Verify the PR is merged into its intended base and the local branch matches the merged PR head,
with no later commits. Check tracked, untracked, and ignored files for work or local data that
removal would discard. A clean `git status` alone does not account for ignored files, and squash
merges do not preserve the feature head as an ancestor of the base branch.

Completing the authorized task includes removing its verified worktree and local branch;
no separate cleanup confirmation is needed unless the user requests retention. Discard only
the merged source and identified, reproducible output generated for this task. Preserve a
worktree with later commits, uncommitted work, private data, uncertain ignored files, or an
active session or process. Report the specific reason for retention and ask only if resolving
it requires a new decision. Preserve the main checkout and other tasks' worktrees; this is
not blanket authorization to clean up previously retained resources.

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

Remove the verified task-local branch with `git branch -d <branch>` only after its worktree is
removed. If Git refuses, including after a squash merge, retain the branch and explain why;
do not silently escalate to `-D`. Remote branch deletion is a separate action. Avoid blanket
worktree pruning or directory deletion to clear an error.

Recheck the worktree registry, removed path, and local branch refs. Report what was actually
removed and what remains; PR delivery, merge, and cleanup are distinct completion states.
