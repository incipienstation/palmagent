import { connect, type Socket } from "node:net";
import type { ClientMsg, ServerMsg } from "./daemon-protocol.js";
import type { ProcHandle, RunnerBackend, SpawnSpec } from "./types.js";

// Web-server side of the runner daemon: a single persistent Unix-socket
// connection that proxies start/attach/stdin/signal and demuxes the daemon's
// line/stderr/exit messages back to per-turn ProcHandle shims.
export class DaemonBackend implements RunnerBackend {
  private sock: Socket | undefined;
  private connected = false;
  private buf = "";
  private handles = new Map<string, RemoteProcHandle>();
  private liveWaiters: Array<(turns: string[]) => void> = [];
  private reconnecting = false;

  constructor(private readonly socketPath: string) {}

  // Dial the socket once, with a short bounded retry. Resolves false if the
  // daemon never answers — the caller then falls back to InProcessBackend.
  async init(): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await this.dial()) return true;
      await delay(300);
    }
    return false;
  }

  private dial(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = connect(this.socketPath);
      let settled = false;
      const ok = () => {
        if (settled) return;
        settled = true;
        this.attachSocket(sock);
        resolve(true);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(false);
      };
      sock.once("connect", ok);
      sock.once("error", fail);
    });
  }

  private attachSocket(sock: Socket): void {
    this.sock = sock;
    this.connected = true;
    this.buf = "";
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("close", () => this.onClose());
    sock.on("error", () => {
      /* close handler does the cleanup */
    });
  }

  private onClose(): void {
    this.connected = false;
    this.sock = undefined;
    // The daemon went away → its children died with it. Settle every in-flight
    // handle so the tasks don't hang, then try to reconnect for future turns.
    for (const h of [...this.handles.values()]) h._exit(-1);
    this.handles.clear();
    for (const w of this.liveWaiters.splice(0)) w([]);
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.connected) {
        if (await this.dial()) break;
        await delay(1000);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString();
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(line) as ServerMsg;
      } catch {
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: ServerMsg): void {
    if (msg.t === "live") {
      for (const w of this.liveWaiters.splice(0)) w(msg.turns);
      return;
    }
    const h = this.handles.get(msg.turnId);
    if (!h) return;
    if (msg.t === "line") h._line(msg.seq, msg.line);
    else if (msg.t === "stderr") h._stderr(msg.text);
    else if (msg.t === "exit") h._exit(msg.code);
  }

  send(msg: ClientMsg): boolean {
    if (!this.sock || !this.connected) return false;
    this.sock.write(JSON.stringify(msg) + "\n");
    return true;
  }

  start(spec: SpawnSpec): ProcHandle {
    const h = new RemoteProcHandle(spec.turnId, this);
    this.handles.set(spec.turnId, h);
    const sent = this.send({
      t: "start",
      turnId: spec.turnId,
      command: spec.command,
      argv: spec.argv,
      cwd: spec.cwd,
      env: spec.env ? stringEnv(spec.env) : undefined,
    });
    // Let the adapter install its exit handler before settling a failed start.
    if (!sent) queueMicrotask(() => h._exit(-1));
    return h;
  }

  attach(turnId: string, fromSeq = 0): ProcHandle | undefined {
    if (!this.connected) return undefined;
    const h = new RemoteProcHandle(turnId, this);
    this.handles.set(turnId, h);
    this.send({ t: "attach", turnId, fromSeq });
    return h;
  }

  listLive(): Promise<string[]> {
    if (!this.connected) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.liveWaiters.push(resolve);
      if (!this.send({ t: "hello" })) resolve([]);
      // Don't hang forever if the daemon never replies.
      setTimeout(() => {
        const i = this.liveWaiters.indexOf(resolve);
        if (i !== -1) {
          this.liveWaiters.splice(i, 1);
          resolve([]);
        }
      }, 5000);
    });
  }

  release(turnId: string): void {
    this.handles.delete(turnId);
    this.send({ t: "release", turnId });
  }
}

// Per-turn shim over the shared connection — looks enough like a child process
// for the adapters to drive it identically to the in-process path.
class RemoteProcHandle implements ProcHandle {
  private lineCbs: Array<(seq: number, line: string) => void> = [];
  private stderrCbs: Array<(text: string) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  private exited = false;
  private stdinOpen = true;

  constructor(readonly turnId: string, private readonly backend: DaemonBackend) {}

  _line(seq: number, line: string): void {
    for (const cb of this.lineCbs) cb(seq, line);
  }
  _stderr(text: string): void {
    for (const cb of this.stderrCbs) cb(text);
  }
  _exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdinOpen = false;
    for (const cb of this.exitCbs) cb(code);
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
    return this.stdinOpen && !this.exited;
  }
  writeStdin(data: string): boolean {
    if (!this.stdinOpen || this.exited) return false;
    return this.backend.send({ t: "stdin", turnId: this.turnId, data });
  }
  closeStdin(): void {
    if (!this.stdinOpen) return;
    this.stdinOpen = false;
    this.backend.send({ t: "closeStdin", turnId: this.turnId });
  }
  kill(signal: NodeJS.Signals): void {
    this.backend.send({ t: "signal", turnId: this.turnId, signal });
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
