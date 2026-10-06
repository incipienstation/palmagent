import type { Repo } from "@palmagent/shared";

export interface RepoRepository {
  insertRepo(repo: Repo): void;
  setRepoBaseRef(id: string, baseRef: string): void;
  getRepo(id: string): Repo | undefined;
  listRepos(): Repo[];
  deleteRepo(id: string): void;
}

export interface RepositoryPathInspection {
  path: string;
  name: string;
  exists: boolean;
  isDirectory: boolean;
  isGit: boolean;
  defaultBaseRef: string;
}

export interface RepositoryPathOperations {
  inspect(path: string, defaultBaseRef?: string): RepositoryPathInspection;
  defaultBaseRef(path: string): Promise<string>;
  validBaseRef(path: string, baseRef: string): boolean;
}

/** Cross-feature coordination supplied by the process composition root. */
export interface SpaceLifecycle {
  tasks(repoId: string): Pick<import("@palmagent/shared").TaskState, "status">[];
  terminals(repoId: string): Pick<import("@palmagent/shared/terminals").TerminalSession, "state">[];
  hasRunningRoutine(repoId: string): boolean;
  removed(repoId: string): void;
}
