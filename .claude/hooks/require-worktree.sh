#!/usr/bin/env bash
# PreToolUse guard for Write/Edit — enforce that all edits happen inside a git
# worktree, never in the repo's MAIN checkout.
#
# Decision: deny the edit when the session cwd is the main checkout of a git
# repo, returning a reason that tells the model to call the EnterWorktree tool
# first. Edits inside a linked worktree, or anywhere outside a git repo, pass
# through untouched.
#
# Detection: a linked worktree's git-dir is `<repo>/.git/worktrees/<name>`,
# while the main checkout's git-dir is `<repo>/.git` (no `/worktrees/` segment).
set -euo pipefail

input=$(cat)

# Prefer the cwd the harness reports; fall back to the process cwd.
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)
[ -n "$cwd" ] || cwd="$PWD"

gitdir=$(git -C "$cwd" rev-parse --absolute-git-dir 2>/dev/null || true)

# Not inside a git repo → nothing to enforce.
[ -n "$gitdir" ] || exit 0

# Already inside a linked worktree → allow.
case "$gitdir" in
  */worktrees/*) exit 0 ;;
esac

# Main checkout → deny, and tell the model exactly how to proceed.
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Edits are not allowed in this repository's main checkout. All changes must happen inside a git worktree — call the EnterWorktree tool first, then edit."}}
JSON
