import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { applicationChecks, applicationIdentity, verifyApplication } from "../src/cli/application-verification.js";
import type { InstallConfig } from "../src/cli/config.js";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-application-check-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "web/assets"), { recursive: true });
  const build = { version: "0.1.0-alpha.1", sourceCommit: "a".repeat(40), dirty: false };
  writeFileSync(join(directory, "package.json"), JSON.stringify({ version: build.version }));
  writeFileSync(join(directory, "build-info.json"), JSON.stringify(build));
  writeFileSync(join(directory, "web/index.html"), '<script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(directory, "web/assets/app.js"), "verified entry");
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert(init?.signal);
    const url = new URL(String(input)); requests.push(url.href);
    if (url.pathname === "/api/health") return Response.json({ ok: true, build });
    return new Response(readFileSync(join(directory, "web", url.pathname === "/" ? "index.html" : url.pathname.slice(1))));
  };
  const cfg = { mode: "package", pkgDir: directory, host: "localhost", port: 4100, authOrigin: "https://palmagent.example.com", rpId: "palmagent.example.com" } as InstallConfig;
  return { directory, build, request, requests, cfg };
}

test("doctor verifies both configured origins without staging configuration", async t => {
  const f = fixture(t);
  const checks = await applicationChecks(f.cfg, f.request);
  assert.deepEqual(checks.map(c => [c.name, c.level]), [["local application", "ok"], ["public application", "ok"]]);
  assert.equal(f.requests.length, 6);
  assert(f.requests.includes("https://palmagent.example.com/assets/app.js"));
});

for (const mismatch of ["commit", "dirty", "shell", "entry"]) test(`rejects a healthy endpoint with mismatched ${mismatch}`, async t => {
  const f = fixture(t);
  const identity = applicationIdentity(f.directory);
  if (mismatch === "commit") f.build.sourceCommit = "b".repeat(40);
  if (mismatch === "dirty") f.build.dirty = true;
  if (mismatch === "shell") writeFileSync(join(f.directory, "web/index.html"), '<script src="https://wrong.example.com/app.js"></script>');
  if (mismatch === "entry") writeFileSync(join(f.directory, "web/assets/app.js"), "stale entry");
  await assert.rejects(verifyApplication(identity, "http://localhost:4100", f.request), /differs/);
  assert(f.requests.every(url => url.startsWith("http://localhost:4100/")));
});

test("public failures remain separate from local verification", async t => {
  const f = fixture(t);
  const checks = await applicationChecks(f.cfg, async (input, init) => {
    if (String(input).startsWith("https:")) throw new Error("Private proxy diagnostics must not leak");
    return f.request(input, init);
  });
  assert.deepEqual(checks.map(c => c.level), ["ok", "fail"]);
  assert(!JSON.stringify(checks).includes("Private proxy"));
});

test("redirects and HTTP errors cannot count as verified assets", async t => {
  const f = fixture(t);
  for (const status of [302, 404, 503]) {
    await assert.rejects(verifyApplication(applicationIdentity(f.directory), f.cfg.authOrigin, async () => new Response(null, { status })), /HTTP failure/);
  }
});

test("invalid installed identity fails before network access; source installs retain their diagnostics", async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "build-info.json"), JSON.stringify({ ...f.build, version: "0.1.0-alpha.2" }));
  assert.equal((await applicationChecks(f.cfg, f.request))[0]?.level, "fail");
  assert.deepEqual(f.requests, []);
  assert.deepEqual(await applicationChecks({ ...f.cfg, mode: "source" }, f.request), []);
});
