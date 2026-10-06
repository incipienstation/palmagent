import type { Repo, CreateRepoRequest, UpdateRepoRequest } from "@palmagent/shared";

/** Operations accepted by the spaces module. */
export interface SpaceUseCases {
  createRepo(req: CreateRepoRequest): Promise<Repo>;
  updateRepo(id: string, req: UpdateRepoRequest): Repo;
  deleteRepo(id: string): Repo;
  listRepos(): Repo[];
  findRepo(id: string): Repo | undefined;
  getRepo(id: string): Repo;
}
