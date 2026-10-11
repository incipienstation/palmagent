import { needsTaskAttention } from "@palmagent/shared";
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

export type SpaceActivity = { latest: number; attention: number; running: number; queued: number };

export function spaceActivities(tasks: readonly TaskState[]): Map<string, SpaceActivity> {
  const spaces = new Map<string, SpaceActivity>();
  for (const task of tasks) {
    if (task.status === "archived") continue;
    let activity = spaces.get(task.repoId);
    if (!activity) { activity = { latest: 0, attention: 0, running: 0, queued: 0 }; spaces.set(task.repoId, activity); }
    activity.latest = Math.max(activity.latest, task.lastActivityAt);
    if (needsTaskAttention(task.status)) activity.attention++;
    if (task.status === "running") activity.running++;
    if (task.status === "queued") activity.queued++;
  }
  return spaces;
}

export function spaceActivitySummary(activity?: SpaceActivity, now = Date.now()): string {
  const { latest, attention, running, queued } = activity ?? { latest: 0, attention: 0, running: 0, queued: 0 };
  const summary = [
    attention ? `${attention} need attention` : "",
    running ? `${running} working` : queued ? `${queued} queued` : "",
  ].filter(Boolean).join(" · ");
  const minutes = Math.max(0, Math.floor((now - latest) / 60_000));
  const time = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return summary || (latest ? `Last active ${time}` : "No tasks yet");
}
