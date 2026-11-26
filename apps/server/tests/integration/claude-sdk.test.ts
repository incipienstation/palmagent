import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InProcessBackend } from "../../src/modules/agents/adapters/outbound/inproc-backend.js";

// The SDK's interrupt receipt can arrive before the old turn finishes. Stop in
// that interval must revoke the queued follow-up without sending its prompt.
test("Claude SDK Stop withdraws a replacement before the interrupted result", { skip: process.platform === "win32", timeout: 20_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "palmagent-sdk-"));
  const config = join(directory, "profile");
  mkdirSync(config);
  const fixture = fileURLToPath(new URL("../support/lifecycle-cli.cjs", import.meta.url));
  writeFileSync(join(directory, "claude"),
    `#!${process.execPath}\nprocess.argv.splice(2, 0, "claude"); require(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, PROBE_CONTROL: process.env.PROBE_CONTROL };
  const backend = new InProcessBackend();
  t.after(async () => {
    await backend.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.PATH = directory + ":" + saved.PATH;
  process.env.PROBE_CONTROL = directory;
  const waitFor = async (suffix: string) => {
    const path = join(directory, "first." + suffix);
    while (!existsSync(path)) await delay(10, undefined, { signal: t.signal });
    return path;
  };
  const handle = backend.agentRunner("claude").start({
    cwd: directory, taskId: "replace", providerHome: config, permission: "manual", interactive: true,
    messageId: randomUUID(), prompt: JSON.stringify({ key: "first", mode: "interrupt-hold" }),
  }, () => {});
  const first = JSON.parse(readFileSync(await waitFor("ready"), "utf8"));
  assert.equal(first.configDir, config);
  assert.equal(first.argv[first.argv.indexOf("--permission-mode") + 1], "manual");
  const receipt = handle.send!(JSON.stringify({ key: "withdrawn", mode: "auto" }), undefined, randomUUID());
  await waitFor("interrupted");
  assert(handle.interrupt());
  assert.equal(await receipt, "rejected");
  writeFileSync(join(directory, "first.release"), "");
  await handle.done;
  assert.equal(existsSync(join(directory, "withdrawn.ready")), false);
});
