import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** A separate socket peer also serves synchronous installer subprocess fixtures. */
export async function startDaemonControlFixture(t: TestContext, dataDir: string) {
  const root = `/tmp/palmagentd-${process.getuid!()}-${createHash("sha256").update(realpathSync(dataDir)).digest("hex").slice(0, 20)}`;
  const child = fork(new URL("./daemon-control.cjs", import.meta.url), [dataDir], { stdio: ["ignore", "ignore", "inherit", "ipc"], execArgv: [] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill(); await done;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Fixture daemon startup timed out")); }, 5000);
    child.once("message", () => { clearTimeout(timer); resolve(); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Fixture daemon exited before readiness")); });
  });
  return { socket: join(root, "control.sock") };
}
