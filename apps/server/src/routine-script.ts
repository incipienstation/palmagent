import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Routine, RoutineRun } from "@palmagent/shared";
import type { Db } from "./db.js";
import { WorktreeManager } from "./worktree.js";

// The pipe is a lifetime lease: even an abrupt parent crash closes stdin and
// the watchdog kills its own process group, including shell descendants.
const watchdog = String.raw`
const { spawn } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => process.kill(-process.pid, "SIGKILL"));
const child = spawn("/bin/sh", ["-c", process.argv[1]], { stdio: ["ignore", "inherit", "inherit"] });
child.on("error", error => { console.error(error.message); process.exit(127); });
child.on("exit", (code, signal) => { if (signal) console.error("terminated by " + signal); process.exit(code ?? 1); });
`;

// Scripts run as the installation owner, without an agent or an interactive shell.
// Retain isolated worktrees: script output/files may be the user's result.
export function runRoutineScript(db: Db, routine: Routine, runId: number): { stop: (reason?: string) => void; done: Promise<void> } {
  let stop = (_reason?: string) => {};
  const done = new Promise<void>((resolve) => {
    let worktreePath: string | undefined;
    const finish = (result: Pick<RoutineRun, "status" | "exitCode" | "note" | "output">) => {
      db.finishRoutineRun(runId, { ...result, worktreePath, finishedAt: Date.now() });
      resolve();
    };
    try {
      const repo = db.getRepo(routine.repoId);
      if (!repo || !routine.script) throw new Error("Script or space no longer exists");
      let cwd = repo.path;
      if (repo.vcs !== "none") {
        worktreePath = new WorktreeManager().create(repo, `routine-${randomBytes(8).toString("hex")}`).path;
        cwd = worktreePath;
      }
      db.finishRoutineRun(runId, { status: "running", worktreePath });
      const child = spawn(process.execPath, ["--input-type=commonjs", "-e", watchdog, routine.script.command], {
        cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "", bytes = 0, truncated = false, reason: string | undefined, settled = false;
      let force: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* already exited */ } }
      };
      const terminate = (why: string) => {
        if (reason || settled) return;
        reason = why;
        kill("SIGTERM");
        force = setTimeout(() => kill("SIGKILL"), 1000);
      };
      stop = (reason = "interrupted by server shutdown") => terminate(reason);
      const timeout = setTimeout(() => terminate("script timed out"), routine.script.timeoutSeconds * 1000);
      const collect = (chunk: Buffer) => {
        const remaining = Math.max(0, 64 * 1024 - bytes);
        output += chunk.subarray(0, remaining).toString("utf8");
        bytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) truncated = true;
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      const complete = (code: number | null, error?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (force) clearTimeout(force);
        // A script must not leave background descendants behind after its shell exits.
        kill("SIGKILL");
        finish({ status: reason?.startsWith("interrupted") ? "interrupted" : code === 0 && !reason && !error ? "succeeded" : "failed",
          exitCode: code ?? undefined, note: reason ?? error, output: output + (truncated ? "\n[output truncated]" : "") });
      };
      child.once("error", error => complete(null, error.message));
      child.once("exit", () => kill("SIGKILL"));
      child.once("close", (code, signal) => complete(code, signal ? `terminated by ${signal}` : undefined));
    } catch (error) {
      finish({ status: "failed", note: error instanceof Error ? error.message : String(error) });
    }
  });
  return { stop: reason => stop(reason), done };
}
