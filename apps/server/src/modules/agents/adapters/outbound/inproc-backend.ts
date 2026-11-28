import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { makeNdjsonSplitter } from "../../../../platform/process/ndjson.js";
import type { ProcHandle, ProcessBackend, SpawnSpec } from "../../application/ports/outbound/provider-process.js";
import type { ExecutionRunner, RunnerBackend } from "../../application/ports/inbound/execution.js";
import type { AgentKind } from "@palmagent/shared";
import { claudeAcpRunner } from "./claude-acp.js";
import { findAgentExecutable } from "./agent-installations.js";
import { normalizePermission } from "@palmagent/shared";
import { claudeSdkRunner } from "./claude-sdk.js";
import { startWithInputFiles } from "./input-files.js";
import type { RunHandle } from "../../domain/run-handle.js";
import { bindRunner } from "./runner.js";

// The default backend: spawn the CLI as a direct child of THIS process, exactly
// as Palmagent did before the runner daemon existed. Used by `pnpm dev` (one
// process, no socket). Because the child dies with this process,
// `attach()` can never reattach and `listLive()` is always empty — restart
// recovery falls back to idle(interrupted), the pre-daemon behavior.
export class InProcessBackend implements RunnerBackend, ProcessBackend {
  private children = new Set<ChildProcessWithoutNullStreams>();

  private claudeRuns = new Set<RunHandle>();

  agentRunner(agent: AgentKind): ExecutionRunner {
    if (agent !== "claude") return bindRunner(agent, this);
    return { agent, start: (args, emit) => {
      // Older installations and Claude modes outside the bridge's ACP catalog
      // keep their native runner. Select before sending any provider input.
      const bundled = fileURLToPath(new URL("./claude-agent-acp.mjs", import.meta.url));
      const bridge = existsSync(bundled) ? { command: process.execPath, argv: [bundled] } : undefined;
      const sourceBridge = bridge ? undefined : findAgentExecutable("claude-agent-acp");
      const transport = bridge ?? (sourceBridge ? { command: sourceBridge, argv: [] } : undefined);
      const executable = findAgentExecutable("claude");
      const useAcp = process.env.PALMAGENT_CLAUDE_TRANSPORT !== "native" && !args.reattach && !args.operation
        && normalizePermission("claude", args.permission) !== "dontAsk";
      const runner = useAcp && transport && executable ? claudeAcpRunner(transport, executable) : claudeSdkRunner;
      const handle = startWithInputFiles(runner, args, emit, this);
      this.claudeRuns.add(handle);
      const release = () => this.claudeRuns.delete(handle);
      void handle.done.then(release, release);
      return handle;
    } };
  }

  async close(): Promise<void> {
    const claudeRuns = [...this.claudeRuns];
    for (const handle of claudeRuns) handle.cancel();
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
    await Promise.allSettled(claudeRuns.map(handle => handle.done));
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
