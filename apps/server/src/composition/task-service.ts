import { TaskService } from "../modules/tasks/application/use-cases/task-service.js";
import { SpaceService } from "../modules/spaces/application/use-cases/space-service.js";
import type { RepoRepository, RepositoryPathOperations } from "../modules/spaces/application/ports/outbound/spaces.js";

type TaskArguments = ConstructorParameters<typeof TaskService>;
type WireSpaces<T extends unknown[]> = {
  [Index in keyof T]: Index extends "0" ? T[Index] & RepoRepository & { hasRunningRoutine(repoId: string): boolean }
    : Index extends "6" ? RepositoryPathOperations : T[Index];
};
type TaskDependencies = WireSpaces<TaskArguments>;

export function createTaskService(...args: TaskDependencies): TaskService {
  const [db, hub, supervisor, backend, worktrees, attachments, paths, nativeSession, ids, ...rest] = args;
  const spaces = new SpaceService(db, paths, ids, hub, {
    tasks: id => service.listTasks().filter(task => task.repoId === id),
    terminals: id => rest[4]?.list({ repoId: id }) ?? [],
    hasRunningRoutine: id => db.hasRunningRoutine(id),
    removed: id => service.spaceRemoved(id),
  });
  const service: TaskService = new TaskService(db, hub, supervisor, backend, worktrees, attachments, spaces, nativeSession, ids, ...rest);
  return service;
}
