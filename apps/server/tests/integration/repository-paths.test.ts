import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalRepositoryPaths } from "../../src/modules/spaces/adapters/outbound/repository-paths.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-base-ref-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main", "remote");
  const remote = join(root, "remote");
  git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial");
  git(remote, "branch", "develop");
  git(root, "clone", remote, "local");
  const local = join(root, "local");
  git(local, "branch", "develop", "origin/develop");
  git(local, "switch", "-c", "feature/task");
  return { root, remote, local, paths: new LocalRepositoryPaths() };
}

test("registration detects the live remote default over stale origin/HEAD and the current feature branch", async t => {
  const f = fixture(t);
  git(f.remote, "switch", "develop");
  assert.equal(git(f.local, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main");
  assert.equal(await f.paths.defaultBaseRef(f.local), "develop");
  assert.equal(git(f.local, "branch", "--show-current"), "feature/task");
  git(f.local, "branch", "-D", "develop");
  assert.equal(await f.paths.defaultBaseRef(f.local), "origin/develop", "remote-tracking refs can start a worktree without creating a local branch");
});

test("offline discovery uses a cached default, then the current checkout; detached and local-only repos remain usable", async t => {
  const f = fixture(t);
  git(f.local, "remote", "set-url", "origin", join(f.root, "missing"));
  assert.equal(await f.paths.defaultBaseRef(f.local), "main");
  git(f.local, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
  assert.equal(await f.paths.defaultBaseRef(f.local), "feature/task");
  git(f.local, "remote", "remove", "origin");
  git(f.local, "checkout", "--detach");
  assert.equal(await f.paths.defaultBaseRef(f.local), "HEAD");
});

test("a sole non-origin remote is detected, while ambiguous remotes preserve the checkout", async t => {
  const f = fixture(t);
  git(f.local, "remote", "rename", "origin", "upstream");
  git(f.remote, "switch", "develop");
  assert.equal(await f.paths.defaultBaseRef(f.local), "develop");
  git(f.local, "remote", "add", "other", f.remote);
  assert.equal(await f.paths.defaultBaseRef(f.local), "feature/task");
});

test("base refs must resolve to commits and cannot inject Git options", t => {
  const f = fixture(t);
  for (const ref of ["main", "origin/develop", "HEAD", git(f.local, "rev-parse", "HEAD")]) assert.equal(f.paths.validBaseRef(f.local, ref), true);
  for (const ref of ["", "missing", "--help", "main\n", "HEAD^{tree}"]) assert.equal(f.paths.validBaseRef(f.local, ref), false);
});
