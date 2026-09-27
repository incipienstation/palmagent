import type { Repo, TaskState } from "@palmagent/shared";

export const ALL_SPACES = "all";
export const spacePath = (repoId: string) => `/spaces/${encodeURIComponent(repoId)}`;
export const newTaskPath = (repoId?: string) => repoId ? `/new/space/${encodeURIComponent(repoId)}` : "/new";

/** Distinguish duplicate names without exposing long paths in every row. */
export function spaceQualifier(repo: Repo, repos: Map<string, Repo>): string | undefined {
  if (![...repos.values()].some(other => other.id !== repo.id && other.name === repo.name)) return;
  const parts = repo.path.split("/").filter(Boolean);
  for (let length = 2; length <= parts.length; length++) {
    const suffix = parts.slice(-length).join("/");
    if (![...repos.values()].some(other => other.id !== repo.id && other.name === repo.name
      && other.path.split("/").filter(Boolean).slice(-length).join("/") === suffix)) return suffix;
  }
  return repo.path;
}
export const SELECTED_SPACE_KEY = "working-directory";
const SELECTED_SPACE_REPO_KEY = "working-directory-repo";

export function readSelectedSpace(): string {
  try {
    return localStorage.getItem(SELECTED_SPACE_KEY) ?? ALL_SPACES;
  } catch {
    return ALL_SPACES;
  }
}

export function readSelectedSpaceRepoId(): string | undefined {
  try {
    return localStorage.getItem(SELECTED_SPACE_REPO_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeSelectedSpace(path: string, repoId?: string): void {
  try {
    if (path === ALL_SPACES) {
      localStorage.removeItem(SELECTED_SPACE_KEY);
      localStorage.removeItem(SELECTED_SPACE_REPO_KEY);
      return;
    }
    localStorage.setItem(SELECTED_SPACE_KEY, path);
    if (repoId) localStorage.setItem(SELECTED_SPACE_REPO_KEY, repoId);
    else localStorage.removeItem(SELECTED_SPACE_REPO_KEY);
  } catch {
    /* storage is best effort; the current screen still owns its selection */
  }
}

export function taskDirectoryFor(task: TaskState, repos: Map<string, Repo>): string {
  return task.worktreePath ?? repos.get(task.repoId)?.path ?? `repo:${task.repoId}`;
}

/**
 * A project Space includes the repository root and all task worktrees that
 * belong to that repository. A worktree Space remains an explicit narrow
 * scope for users who want only one isolated task directory.
 */
export function taskBelongsToSpace(task: TaskState, selected: string, repos: Map<string, Repo>): boolean {
  if (selected === ALL_SPACES) return true;
  if (repos.get(task.repoId)?.path === selected) return true;
  return taskDirectoryFor(task, repos) === selected;
}

export function repoForSelectedSpace(
  selected: string,
  repos: Map<string, Repo>,
  tasks: TaskState[] = [],
): string | undefined {
  if (selected === ALL_SPACES) return undefined;
  const direct = [...repos.values()].find((repo) => repo.path === selected);
  if (direct) return direct.id;
  const task = tasks.find((candidate) => taskDirectoryFor(candidate, repos) === selected);
  if (task) return task.repoId;
  const remembered = readSelectedSpaceRepoId();
  return remembered && repos.has(remembered) ? remembered : undefined;
}

export function spaceName(selected: string, repos: Map<string, Repo>, tasks: TaskState[] = []): string {
  if (selected === ALL_SPACES) return "All spaces";
  const repo = [...repos.values()].find((candidate) => candidate.path === selected);
  if (repo) return repo.name;
  const task = tasks.find((candidate) => taskDirectoryFor(candidate, repos) === selected);
  return task ? taskTitlePath(taskDirectoryFor(task, repos)) : taskTitlePath(selected);
}

function taskTitlePath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}
