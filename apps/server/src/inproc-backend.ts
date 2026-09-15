import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { makeNdjsonSplitter } from "./ndjson.js";
import type { ProcHandle, RunnerBackend, SpawnSpec } from "./types.js";

// The default backend: spawn the CLI as a direct child of THIS process, exactly
// as Palmagent did before the runner daemon existed. Used by `pnpm dev` (one
// process, no socket). Because the child dies with this process,
// `attach()` can never reattach and `listLive()` is always empty — restart
// recovery falls back to idle(interrupted), the pre-daemon behavior.
export class InProcessBackend implements RunnerBackend {
  private children = new Set<ChildProcessWithoutNullStreams>();

  async close(): Promise<void> {
    await Promise.all([...this.children].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await exited; } finally {
        clearTimeout(deadline);
        // A descendant retaining inherited pipes must not hold shutdown open.
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }
    }));
  }
  start(spec: SpawnSpec): ProcHandle {
    const child: ChildProcessWithoutNullStreams = spawn(spec.command, spec.argv, {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.children.add(child);
    child.once("close", () => this.children.delete(child));
    return new ChildProcHandle(spec.turnId, child);
  }

  // A child can't outlive its parent process, so there is nothing to reattach to.
  attach(): ProcHandle | undefined {
    return undefined;
  }

  async listLive(): Promise<string[]> {
    return [];
  }
}

// Wraps a real ChildProcess as a ProcHandle: owns the NDJSON splitter and the
// per-turn line seq so callers consume lines (not raw chunks) identically to the
// daemon path.
export class ChildProcHandle implements ProcHandle {
  private seq = 0;
  private lineCbs: Array<(seq: number, line: string) => void> = [];
  private stderrCbs: Array<(text: string) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  private readonly splitter = makeNdjsonSplitter((line) => {
    const s = ++this.seq;
    for (const cb of this.lineCbs) cb(s, line);
  });

  constructor(readonly turnId: string, private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (d) => this.splitter.push(d));
    child.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (text) for (const cb of this.stderrCbs) cb(text);
    });
    let drainDeadline: NodeJS.Timeout | undefined;
    let failed = false;
    child.on("exit", () => {
      // Exit can precede the final stdout data. Give inherited descendant pipes
      // a bounded drain window, while normal EOF completes immediately.
      drainDeadline = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      }, 2000);
      drainDeadline.unref();
    });
    child.on("close", (code) => {
      if (drainDeadline) clearTimeout(drainDeadline);
      this.splitter.flush();
      for (const cb of this.exitCbs) cb(failed ? -1 : code);
    });
    child.on("error", () => { failed = true; });
  }

  onLine(cb: (seq: number, line: string) => void): void {
    this.lineCbs.push(cb);
  }
  onStderr(cb: (text: string) => void): void {
    this.stderrCbs.push(cb);
  }
  onExit(cb: (code: number | null) => void): void {
    this.exitCbs.push(cb);
  }
  stdinWritable(): boolean {
    return this.child.stdin.writable;
  }
  writeStdin(data: string): boolean {
    if (!this.child.stdin.writable) return false;
    this.child.stdin.write(data);
    return true;
  }
  closeStdin(): void {
    if (this.child.stdin.writable) this.child.stdin.end();
  }
  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }
}
