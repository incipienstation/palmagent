import Database from "better-sqlite3";
import type { Repo } from "@palmagent/shared";

type RepoRow = {
  id: string; name: string; path: string; vcs: string; default_base_ref: string; created_at: number;
};

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    vcs: r.vcs === "none" ? "none" : "git",
    defaultBaseRef: r.default_base_ref,
    createdAt: r.created_at,
  };
}

export class SqliteSpaces {
constructor(private readonly db: Database.Database) {}
insertRepo(r: Repo) {
    this.db.prepare(
      `INSERT INTO repos (id, name, path, vcs, default_base_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.path, r.vcs, r.defaultBaseRef, r.createdAt);
  }

setRepoBaseRef(id: string, baseRef: string) {
    this.db.prepare("UPDATE repos SET default_base_ref = ? WHERE id = ?").run(baseRef, id);
  }

getRepo(id: string): Repo | undefined {
    const row = this.db.prepare(`SELECT * FROM repos WHERE id = ?`).get(id) as RepoRow | undefined;
    return row && rowToRepo(row);
  }

listRepos(): Repo[] {
    return (this.db.prepare(`SELECT * FROM repos ORDER BY created_at`).all() as RepoRow[]).map(rowToRepo);
  }

deleteRepo(id: string) {
    // Cascade by hand: tasks/routines carry a FK to repos(id), and events/
    // approvals key off task_id (no declared FK). Archived tasks legitimately
    // still reference the repo, so a bare DELETE FROM repos trips
    // SQLITE_CONSTRAINT_FOREIGNKEY. Tear it all down in one transaction.
    // (Worktrees of archived tasks were already removed at archive time.)
    this.db.transaction((repoId: string) => {
      const taskIds = (
        this.db.prepare(`SELECT id FROM tasks WHERE repo_id = ?`).all(repoId) as { id: string }[]
      ).map((r) => r.id);
      const delEvents = this.db.prepare(`DELETE FROM events WHERE task_id = ?`);
      const delApprovals = this.db.prepare(`DELETE FROM approvals WHERE task_id = ?`);
      for (const tid of taskIds) {
        delEvents.run(tid);
        delApprovals.run(tid);
      }
      this.db.prepare(`DELETE FROM tasks WHERE repo_id = ?`).run(repoId);
      const routineIds = (
        this.db.prepare(`SELECT id FROM routines WHERE repo_id = ?`).all(repoId) as { id: string }[]
      ).map((r) => r.id);
      const delRuns = this.db.prepare(`DELETE FROM routine_runs WHERE routine_id = ?`);
      for (const rid of routineIds) delRuns.run(rid);
      this.db.prepare(`DELETE FROM routines WHERE repo_id = ?`).run(repoId);
      this.db.prepare(`DELETE FROM repos WHERE id = ?`).run(repoId);
    })(id);
  }
}
