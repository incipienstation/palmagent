import type { Repo, CreateRepoRequest, UpdateRepoRequest } from "@palmagent/shared";

export interface TaskSpaces {
  createRepo(input: CreateRepoRequest): Promise<Repo>;
  updateRepo(id: string, input: UpdateRepoRequest): Repo;
  deleteRepo(id: string): Repo;
  listRepos(): Repo[];
  findRepo(id: string): Repo | undefined;
  getRepo(id: string): Repo;
}
