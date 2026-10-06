import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Repo } from "@palmagent/shared";

// One git worktree + branch per isolated task. The worktree
// path is the task's stable cwd for its whole life: Claude's transcript is keyed
// by cwd, so the worktree must outlive the session — we only remove it on
// archive/cancel.

export interface Worktree {
  branch: string;
  path: string;
}

export class WorktreeManager {
  // git worktree add <repo>/.palmagent/worktrees/<taskId> -b agent/<taskId> <base-ref>
  create(repo: Repo, taskId: string): Worktree {
    const branch = `agent/${taskId}`;
    const path = join(repo.path, ".palmagent", "worktrees", taskId);
    ensureExcluded(repo.path);
    git(repo.path, ["worktree", "add", path, "-b", branch, repo.defaultBaseRef]);
    return { branch, path };
  }

  // Best-effort teardown — never throw on cleanup (the task is already terminal).
  remove(repo: Repo, wt: Worktree): void {
    try {
      git(repo.path, ["worktree", "remove", "--force", wt.path]);
    } catch {
      /* worktree may already be gone */
    }
    try {
      git(repo.path, ["branch", "-D", wt.branch]);
    } catch {
      /* branch may already be gone */
    }
  }
}

// The repo's current branch (HEAD), used as the default fork point for new
// worktrees. Falls back to "HEAD" for a detached checkout.
export function detectDefaultBranch(repoPath: string): string {
  try {
    const out = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    return out && out !== "HEAD" ? out : "HEAD";
  } catch {
    return "HEAD";
  }
}

export function isGitRepo(repoPath: string): boolean {
  try {
    return git(repoPath, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

// The work-tree root containing `path` (rev-parse --show-toplevel), or
// undefined when the path is missing or outside any git work tree. Registration
// snaps to this so a repo's subdirectory never becomes a repo entry of its own.
export function gitToplevel(path: string): string | undefined {
  try {
    return git(path, ["rev-parse", "--show-toplevel"]).trim() || undefined;
  } catch {
    return undefined;
  }
}

function git(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Keep .palmagent/ out of the *target* repo's `git status` without touching any
// tracked file — write it to .git/info/exclude (per-clone, never committed).
function ensureExcluded(repoPath: string) {
  try {
    const excl = join(repoPath, ".git", "info", "exclude");
    const cur = existsSync(excl) ? readFileSync(excl, "utf8") : "";
    if (!cur.split("\n").includes(".palmagent/")) {
      appendFileSync(excl, (cur && !cur.endsWith("\n") ? "\n" : "") + ".palmagent/\n");
    }
  } catch {
    /* .git may be a file (nested worktree) — non-fatal */
  }
}
