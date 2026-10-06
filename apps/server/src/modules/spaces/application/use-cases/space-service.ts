import type { SpaceUseCases } from "../ports/inbound/space-use-cases.js";
import type { Repo, CreateRepoRequest, UpdateRepoRequest } from "@palmagent/shared";
import type { RepoRepository, RepositoryPathOperations, SpaceLifecycle } from "../ports/outbound/spaces.js";
import type { IdentifierGenerator } from "../../../../kernel/identifiers.js";
import type { ReadChangePublisher } from "../../../../kernel/events.js";
import { ApplicationError } from "../../../../kernel/errors.js";
const badRequest = (message: string) => new ApplicationError("bad_request", message);
const conflict = (message: string) => new ApplicationError("conflict", message);
const notFound = (message: string) => new ApplicationError("not_found", message);

export class SpaceService implements SpaceUseCases {
  constructor(private db: RepoRepository, private repositoryPaths: RepositoryPathOperations,
    private ids: IdentifierGenerator, private hub: ReadChangePublisher, private lifecycle: SpaceLifecycle) {}
  async createRepo(req: CreateRepoRequest): Promise<Repo> {
    if (!req?.path) throw badRequest("path is required");
    const inspected = this.repositoryPaths.inspect(req.path, req.defaultBaseRef);
    if (!inspected.isGit && !inspected.isDirectory) throw badRequest(inspected.exists
      ? `not a directory: ${inspected.path}`
      : `no such directory: ${inspected.path}`);
    // Git paths snap to the work-tree root (registering /repo/sub must not
    // scatter hidden worktree directories inside subdirectories); a plain directory with no
    // git registers as-is (vcs "none" — tasks run in place, no worktree).
    // Dedupe by path — re-adding returns the existing entry.
    const path = inspected.path;
    const existing = this.db.listRepos().find((r) => r.path === path);
    if (existing) return existing;
    const baseRef = inspected.isGit
      ? req.defaultBaseRef?.trim() || await this.repositoryPaths.defaultBaseRef(path) : "";
    if (inspected.isGit && req.defaultBaseRef && !this.repositoryPaths.validBaseRef(path, baseRef)) {
      throw badRequest("Base branch must resolve to an existing local Git commit. Fetch the branch first if needed.");
    }
    // Remote discovery yields: another request may have registered the same path.
    const registered = this.db.listRepos().find((r) => r.path === path);
    if (registered) return registered;
    const repo: Repo = {
      id: this.ids.next("r"),
      name: req.name || inspected.name,
      path,
      vcs: inspected.isGit ? "git" : "none",
      defaultBaseRef: baseRef,
      createdAt: Date.now(),
    };
    this.db.insertRepo(repo);
    this.hub.emitReadChange({ type: "read-change", repos: true });
    return repo;
  }
  updateRepo(id: string, req: UpdateRepoRequest): Repo {
    const repo = this.getRepo(id);
    if (repo.vcs === "none") throw badRequest("Plain folders do not have a base branch.");
    const baseRef = req.defaultBaseRef.trim();
    if (!this.repositoryPaths.validBaseRef(repo.path, baseRef)) {
      throw badRequest("Base branch must resolve to an existing local Git commit. Fetch the branch first if needed.");
    }
    this.db.setRepoBaseRef(id, baseRef);
    this.hub.emitReadChange({ type: "read-change", repos: true });
    return { ...repo, defaultBaseRef: baseRef };
  }
  deleteRepo(id: string): Repo {
    const repo = this.getRepo(id);
    const live = this.lifecycle.tasks(id).filter(t => t.status !== "archived");
    if (live.length) throw conflict(`repo has ${live.length} non-archived task(s) — archive them first`);
    if (this.lifecycle.terminals(id).some(t => ["starting", "running", "closing"].includes(t.state))) throw conflict("Close this Space\'s terminals before removing it");
    if (this.lifecycle.hasRunningRoutine(id)) throw conflict("Stop this Space's running scripts before removing it");
    this.db.deleteRepo(id);
    this.hub.emitReadChange({ type: "read-change", repos: true, usage: true, routines: true });
    this.lifecycle.removed(id);
    return repo;
  }
  listRepos(): Repo[] {
    return this.db.listRepos();
  }
  findRepo(id: string): Repo | undefined { return this.db.getRepo(id); }
  getRepo(id: string): Repo {
    const r = this.db.getRepo(id);
    if (!r) throw notFound(`no such repo: ${id}`);
    return r;
  }

}
