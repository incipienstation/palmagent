import type { Repo, TaskState } from "@palmagent/shared";

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

export function taskDirectoryFor(task: TaskState, repos: Map<string, Repo>): string {
  return task.worktreePath ?? repos.get(task.repoId)?.path ?? `repo:${task.repoId}`;
}

export function spaceActivity(repoId: string, tasks: TaskState[]) {
  const items = tasks.filter(task => task.repoId === repoId && task.status !== "archived");
  const attention = items.filter(task => ["awaiting_input", "awaiting_approval"].includes(task.status)).length;
  const running = items.filter(task => task.status === "running").length;
  const queued = items.filter(task => task.status === "queued").length;
  const latest = Math.max(0, ...items.map(task => task.lastActivityAt));
  const summary = [
    attention ? `${attention} need attention` : "",
    running ? `${running} working` : queued ? `${queued} queued` : "",
  ].filter(Boolean).join(" · ");
  const minutes = Math.max(0, Math.floor((Date.now() - latest) / 60_000));
  const time = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return { latest, summary: summary || (latest ? `Last active ${time}` : "No tasks yet") };
}
