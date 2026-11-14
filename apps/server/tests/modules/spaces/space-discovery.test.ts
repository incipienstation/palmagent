import assert from "node:assert/strict";
import { test } from "node:test";
import type { Repo } from "@palmagent/shared";
import { SpaceDiscoveryService } from "../../../src/modules/spaces/application/use-cases/space-discovery.js";
import type { SpaceDiscovery, DiscoveryPathInspection } from "../../../src/modules/spaces/application/ports/outbound/discovery.js";
import { repositorySuggestions } from "../../../src/modules/spaces/domain/repository-suggestions.js";

function fixture() {
  const registered: Repo[] = [];
  let roots = ["/projects"];
  const calls: unknown[] = [];
  let inspection: DiscoveryPathInspection = { resolved: "/projects/project/sub", name: "sub", exists: true, isDir: true, root: "/projects/project", branch: "main" };
  const scanned = [{ path: "/projects/project", name: "project", branch: "main", lastActivityAt: 1 }];
  const discovery: SpaceDiscovery = {
    inspect: path => { calls.push(["inspect", path]); return inspection; },
    scan: (roots, refresh) => { calls.push(["scan", roots, refresh]); return { repos: scanned, scannedAt: 10 }; },
    browse: (path, roots) => { calls.push(["browse", path, roots]); return { path: path ?? roots[0], entries: [] }; },
  };
  const service = new SpaceDiscoveryService(discovery, { get: () => ({ repoRoots: roots, defaults: [], source: "saved" }) }, { listRepos: () => registered });
  return { service, calls, scanned, setInspection: (value: DiscoveryPathInspection) => { inspection = value; },
    roots: (value: string[]) => { roots = value; },
    register: (path: string) => registered.push({ id: "registered", name: "project", path, vcs: "git", defaultBaseRef: "main", createdAt: 0 }),
  };
}

test("Git subdirectories match registration at the inspected root without scanning", () => {
  const f = fixture(); f.register("/projects/project");
  assert.deepEqual(f.service.validate("  /projects/project/sub "), { input: "  /projects/project/sub ", resolved: "/projects/project/sub",
    exists: true, isDir: true, isGit: true, root: "/projects/project", branch: "main", repoId: "registered", suggestions: [] });
  assert.equal(f.calls.length, 1);
});

test("plain folders match their own path and skip suggestions", () => {
  const f = fixture(); f.register("/projects/plain");
  f.setInspection({ resolved: "/projects/plain", name: "plain", exists: true, isDir: true });
  assert.deepEqual(f.service.validate("plain"), { input: "plain", resolved: "/projects/plain", exists: true, isDir: true, isGit: false, repoId: "registered", suggestions: [] });
  assert.equal(f.calls.length, 1);
});

for (const exists of [false, true]) test(`invalid ${exists ? "file" : "missing path"} gets suggestions from current roots`, () => {
  const f = fixture(); f.roots(["/current"]);
  f.setInspection({ resolved: "/projects/projec", name: "projec", exists, isDir: false });
  assert.deepEqual(f.service.validate("projec").suggestions, ["/projects/project"]);
  assert.deepEqual(f.calls.at(-1), ["scan", ["/current"], false]);
});

test("cached scan facts receive fresh registration annotations without mutation", () => {
  const f = fixture();
  assert.equal(f.service.discover(false).repos[0].repoId, undefined);
  f.register("/projects/project");
  assert.equal(f.service.discover(false).repos[0].repoId, "registered");
  assert(!("repoId" in f.scanned[0]));
  f.service.discover(true); assert.deepEqual(f.calls.at(-1), ["scan", ["/projects"], true]);
  f.roots([]); f.service.browse(); assert.deepEqual(f.calls.at(-1), ["browse", undefined, []]);
});

test("suggestions are case-insensitive, bounded to three, and stable for ties", () => {
  const candidates = ["cat", "bat", "cut", "cot", "elephant"].map(name => ({ name, path: `/projects/${name}` }));
  assert.deepEqual(repositorySuggestions("CAT", candidates), ["/projects/cat", "/projects/bat", "/projects/cut"]);
  assert.deepEqual(repositorySuggestions("project", [{ name: "proxxxt", path: "/near" }, { name: "xxxxxxx", path: "/far" }]), ["/near"]);
});
