import type { AgentKind, PrRef, Repo } from "@palmagent/shared";
import type { TerminalSession } from "@palmagent/shared/terminals";
import type { RunHandle } from "../../../../agents/api.js";

export interface TaskDefaults {
  model: Partial<Record<import("@palmagent/shared").AgentKind, string>>;
  effort: Partial<Record<import("@palmagent/shared").AgentKind, string>>;
}

export interface PrStatusSink {
  tasksWithPrs(): { taskId: string; prs: PrRef[] }[];
  applyPrStatuses(taskId: string, patches: Map<string, Partial<PrRef>>): void;
}

export interface TerminalTaskLifecycle {
  list(query: { repoId: string }): Pick<TerminalSession, "state">[];
  cleanup(cwd: string, taskId: string, removeWorktree: () => void): void;
}

export interface TaskSupervisor {
  tryAcquire(): boolean;
  acquire(): Promise<void>;
  register(taskId: string, handle: RunHandle): void;
  reclaim(taskId: string, handle: RunHandle): void;
  get(taskId: string): RunHandle | undefined;
  has(taskId: string): boolean;
  release(taskId: string): void;
}

export interface TaskWorktreeManager {
  create(repo: Repo, taskId: string): { branch: string; path: string };
  remove(repo: Repo, worktree: { branch: string; path: string }): void;
}
