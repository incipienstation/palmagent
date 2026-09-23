import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexModelCatalogService, defaultCodexModelCatalog, parseCodexModelCatalog, readCodexModelCatalog } from "../src/model-catalog.js";

const runtimeResponse = {
  data: [
    { id: "hidden", model: "hidden", hidden: true, supportedReasoningEfforts: [{ reasoningEffort: "max" }] },
    { id: "astra", model: "gpt-6-astra", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "ultra" }] },
    { id: "luna", model: "gpt-6-luna", supportedReasoningEfforts: ["low", "max"] },
  ],
  accountId: "private-account-must-not-leak",
};

test("model catalog projects visible models and efforts without provider metadata", () => {
  const catalog = parseCodexModelCatalog(runtimeResponse, 123);
  assert.deepEqual(catalog.models, [
    { value: "default", label: "default", efforts: [{ value: "default", label: "default" }, { value: "low", label: "low" }, { value: "ultra", label: "ultra" }] },
    { value: "gpt-6-astra", label: "gpt-6-astra", efforts: [{ value: "default", label: "default" }, { value: "low", label: "low" }, { value: "ultra", label: "ultra" }] },
    { value: "gpt-6-luna", label: "gpt-6-luna", efforts: [{ value: "default", label: "default" }, { value: "low", label: "low" }, { value: "max", label: "max" }] },
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /hidden|private-account/);
  assert.equal(catalog.source, "runtime");
  assert.equal(catalog.fetchedAt, 123);
});

test("catalog reads coalesce, serve stale data while refreshing, and retain the last success", async () => {
  let now = 1;
  let reads = 0;
  let rejectRefresh: ((error: Error) => void) | undefined;
  const reader = new CodexModelCatalogService(async () => {
    reads++;
    if (reads === 1) return runtimeResponse;
    return new Promise((_, reject) => { rejectRefresh = reject; });
  }, () => now);
  const first = reader.get("/fixture/account");
  const second = reader.get("/fixture/account");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, secondResult);
  assert.equal(reads, 1);
  now += 300_001;
  const stale = await reader.get("/fixture/account");
  assert.equal(stale.source, "stale");
  assert.equal(stale.models[1]?.value, "gpt-6-astra");
  assert.equal(reads, 2);
  rejectRefresh?.(new Error("temporary CLI failure"));
  await new Promise<void>(resolve => setImmediate(resolve));
  now += 30_001;
  const staleAgain = await reader.get("/fixture/account");
  assert.equal(staleAgain.source, "stale");
  assert.equal(staleAgain.models[1]?.value, "gpt-6-astra");
  assert.equal(reads, 3);
});

test("a first discovery failure returns a default-only catalog and is retried after a short interval", async () => {
  let now = 1;
  let reads = 0;
  const reader = new CodexModelCatalogService(async () => { reads++; throw new Error("CLI unavailable"); }, () => now);
  const first = await reader.get("/fixture/account");
  assert.deepEqual(first, defaultCodexModelCatalog());
  assert.equal(reads, 1);
  assert.deepEqual(await reader.get("/fixture/account"), first);
  assert.equal(reads, 1);
  now += 30_001;
  assert.deepEqual(await reader.get("/fixture/account"), first);
  assert.equal(reads, 2);
});

test("the installed CLI protocol reader requests model/list without starting a turn", async t => {
  const dir = mkdtempSync(join(tmpdir(), "palmagent-catalog-test-"));
  const bin = join(dir, "bin");
  const home = join(dir, "provider-home");
  mkdirSync(bin); mkdirSync(home);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  t.after(() => { process.env.PATH = previousPath; rmSync(dir, { recursive: true, force: true }); });
  const fixture = join(bin, "codex-fixture.cjs");
  writeFileSync(fixture, `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const home = process.env.CODEX_HOME;
fs.writeFileSync(path.join(home, "selected-home"), "yes");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(path.join(home, "requests"), line + "\\n");
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  else if (message.method === "model/list") process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ model: "fixture-model", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] } }) + "\\n");
});
`, { mode: 0o755 });
  chmodSync(fixture, 0o755);
  symlinkSync(fixture, join(bin, "codex"));
  const catalog = parseCodexModelCatalog(await readCodexModelCatalog(home), 1);
  assert.equal(readFileSync(join(home, "selected-home"), "utf8"), "yes");
  const requests = readFileSync(join(home, "requests"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(requests.map(request => request.method), ["initialize", "initialized", "model/list"]);
  assert.equal(requests[2].params.includeHidden, false);
  assert.deepEqual(catalog.models.map(model => model.value), ["default", "fixture-model"]);
});
