import type { Repo } from "@palmagent/shared";

export interface SpaceCatalogWriter {
  insertRepo(repo: Repo): void;
  /** Returns the previously registered Space, or null after inserting the candidate. */
  registerRepo(repo: Repo): Repo | null;
  setRepoBaseRef(id: string, baseRef: string): void;
  deleteRepo(id: string): void;
}

export interface RepoRepository extends SpaceCatalogWriter {
  getRepo(id: string): Repo | undefined;
  getRepoByPath(path: string): Repo | undefined;
  listRepos(): Repo[];
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
