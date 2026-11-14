import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { SpaceDiscoveryService } from "../../src/modules/spaces/application/use-cases/space-discovery.js";
import { localSpaceDiscovery } from "../../src/modules/spaces/adapters/outbound/local-discovery.js";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "palmagent-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "project"), plain = join(root, "plain");
  mkdirSync(repository); mkdirSync(plain); mkdirSync(join(repository, "sub"));
  execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "fixture"], { stdio: "ignore" });
  const service = new SpaceDiscoveryService(localSpaceDiscovery,
    { get: () => ({ repoRoots: [root], defaults: [], source: "saved" }) },
    { listRepos: () => [{ id: "repository", name: "project", path: repository, vcs: "git", defaultBaseRef: "main", createdAt: 0 },
      { id: "plain", name: "plain", path: plain, vcs: "none", defaultBaseRef: "", createdAt: 0 }] });
  return { root, repository, plain, service };
}

test("real filesystem and Git inspection preserve path normalization, registration, and suggestions", t => {
  const f = fixture(t), input = ` ${join(f.repository, "sub")} `;
  const git = f.service.validate(input);
  assert.equal(git.input, input); assert.equal(git.resolved, join(f.repository, "sub"));
  assert.equal(git.root, f.repository); assert.equal(git.branch, "main"); assert.equal(git.repoId, "repository");
  assert.equal(f.service.validate(f.plain).repoId, "plain");
  assert.deepEqual(f.service.validate(join(f.root, "projec")).suggestions, [f.repository]);
  writeFileSync(join(f.root, "project.txt"), "fixture");
  const file = f.service.validate(join(f.root, "project.txt"));
  assert.equal(file.exists, true); assert.equal(file.isDir, false); assert.equal(file.isGit, false);
  assert.deepEqual(file.suggestions, [f.repository]);
});

test("browse retains configured defaults, hidden-directory filtering, and scope checks", t => {
  const f = fixture(t); mkdirSync(join(f.root, ".hidden")); mkdirSync(join(f.root, "node_modules"));
  const result = f.service.browse();
  assert.equal(result.path, f.root); assert.deepEqual(result.entries.map(entry => entry.name), ["project", "plain"]);
  assert.throws(() => f.service.browse(dirname(f.root)), { code: "forbidden" });
});
