import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNdjsonSplitter } from "./ndjson.js";

interface QueryChannel {
  send(value: unknown): void;
  finish(error?: Error, value?: unknown): void;
}
interface QueryOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Caller-owned project cwd, or an isolated temporary directory owned by this query. */
  cwd?: string;
  directoryPrefix?: string;
  timeoutMs: number;
  maxBytes?: number;
  errors: { unavailable: string; channel: string; timeout: string; tooLarge: string; exited: string };
  initialize(channel: QueryChannel): void;
  receive(message: Record<string, unknown>, channel: QueryChannel): void;
}

/** A bounded one-shot reader. Provider protocol and caching stay with the caller. */
export async function readNdjsonQuery(options: QueryOptions): Promise<unknown> {
  const temporary = options.cwd === undefined;
  const cwd = options.cwd ?? await mkdtemp(join(tmpdir(), options.directoryPrefix ?? "palmagent-query-"));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(options.command, options.args, { cwd, env: { ...process.env, ...options.env },
        stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32" });
      let done = false, bytes = 0;
      let result: unknown, failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* The process group has already exited. */ }
      };
      const finish = (error?: Error, value?: unknown) => {
        if (done) return;
        done = true; failure = error; result = value;
        clearTimeout(timer);
        try { child.stdin.end(); } catch { /* Shutdown continues even if stdin is gone. */ }
        stop("SIGTERM");
        killTimer = setTimeout(() => stop("SIGKILL"), 1000);
        killTimer.unref();
      };
      const channel: QueryChannel = { finish, send(value) {
        if (done) return;
        try { child.stdin.write(`${JSON.stringify(value)}\n`); }
        catch { finish(new Error(options.errors.channel)); }
      } };
      const timer = setTimeout(() => finish(new Error(options.errors.timeout)), options.timeoutMs);
      timer.unref();
      child.stdin.on("error", () => finish(new Error(options.errors.channel)));
      child.on("error", () => finish(new Error(options.errors.unavailable)));
      child.on("close", () => {
        clearTimeout(timer); clearTimeout(killTimer);
        // Kill descendants that retained inherited pipes or survived their parent.
        stop("SIGKILL");
        if (!done || failure) reject(failure ?? new Error(options.errors.exited));
        else resolve(result);
      });
      const lines = makeNdjsonSplitter(line => {
        if (done) return;
        let message: unknown;
        try { message = JSON.parse(line); } catch { return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) return;
        try { options.receive(message as Record<string, unknown>, channel); }
        catch (error) { finish(error instanceof Error ? error : new Error("Query response handling failed")); }
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (done) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > (options.maxBytes ?? 1_048_576)) { finish(new Error(options.errors.tooLarge)); return; }
        lines.push(chunk);
      });
      try { options.initialize(channel); }
      catch (error) { finish(error instanceof Error ? error : new Error("Query initialization failed")); }
    });
  } finally { if (temporary) await rm(cwd, { recursive: true, force: true }); }
}
