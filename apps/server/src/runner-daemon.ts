import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { makeNdjsonSplitter } from "./ndjson.js";
import { DEFAULT_RUNNER_SOCKET, type ClientMsg, type ServerMsg } from "./daemon-protocol.js";

// The runner daemon: a long-lived process that OWNS the claude/codex children and
// their stdio, so the Palmagent web server can restart on every
// deploy without killing in-flight turns. It is deliberately dumb about content —
// it spawns whatever argv it's told, splits stdout into NDJSON lines (assigning a
// per-turn seq), buffers them for replay, and forwards them to connected clients.
// ALL CLI-specific knowledge stays in the web server's adapters.

interface Turn {
  turnId: string;
  child: ChildProcessWithoutNullStreams;
  lines: string[]; // lines[i] is the line with seq i+1 — kept until release
  exitCode: number | null | undefined; // undefined => still running
  exited: boolean;
  subscribers: Set<Socket>;
}

class RunnerDaemon {
  private turns = new Map<string, Turn>();
  private server: Server;

  constructor(private readonly socketPath: string) {
    this.server = createServer((sock) => this.onConnection(sock));
  }

  listen(): void {
    const dir = dirname(this.socketPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(this.socketPath)) {
      try {
        unlinkSync(this.socketPath); // clear a stale socket from a prior daemon
      } catch {
        /* best effort */
      }
    }
    this.server.listen(this.socketPath, () => {
      console.log(`[runner] listening on ${this.socketPath}`);
    });
    this.server.on("error", (e) => console.error("[runner] server error", e));
  }

  private send(sock: Socket, msg: ServerMsg): void {
    if (sock.writable) sock.write(JSON.stringify(msg) + "\n");
  }

  private onConnection(sock: Socket): void {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: ClientMsg;
        try {
          msg = JSON.parse(line) as ClientMsg;
        } catch {
          continue;
        }
        this.handle(sock, msg);
      }
    });
    const drop = () => {
      // A client (web server) disconnecting must NOT touch the turns — the whole
      // point is they outlive the connection. Just stop forwarding to this sock.
      for (const turn of this.turns.values()) turn.subscribers.delete(sock);
    };
    sock.on("close", drop);
    sock.on("error", drop);
  }

  private handle(sock: Socket, msg: ClientMsg): void {
    switch (msg.t) {
      case "hello":
        this.send(sock, { t: "live", turns: [...this.turns.keys()] });
        return;
      case "start":
        this.startTurn(sock, msg.turnId, msg.command, msg.argv, msg.cwd, msg.env);
        return;
      case "attach":
        this.attachTurn(sock, msg.turnId, msg.fromSeq);
        return;
      case "stdin": {
        const t = this.turns.get(msg.turnId);
        if (t && t.child.stdin.writable) t.child.stdin.write(msg.data);
        return;
      }
      case "closeStdin": {
        const t = this.turns.get(msg.turnId);
        if (t && t.child.stdin.writable) t.child.stdin.end();
        return;
      }
      case "signal": {
        const t = this.turns.get(msg.turnId);
        if (t && !t.exited) {
          try {
            t.child.kill(msg.signal);
          } catch {
            /* already gone */
          }
        }
        return;
      }
      case "release": {
        const t = this.turns.get(msg.turnId);
        if (t) {
          if (!t.exited) {
            try {
              t.child.kill("SIGKILL");
            } catch {
              /* ignore */
            }
          }
          this.turns.delete(msg.turnId);
        }
        return;
      }
    }
  }

  private startTurn(
    sock: Socket,
    turnId: string,
    command: string,
    argv: string[],
    cwd: string,
    env?: Record<string, string>,
  ): void {
    // Idempotency guard: a duplicate start for a live turn just (re)subscribes.
    const existing = this.turns.get(turnId);
    if (existing) {
      this.attachTurn(sock, turnId, 0);
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, argv, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      // Surface the spawn failure as an immediate exit so the web server settles.
      this.send(sock, { t: "stderr", turnId, text: `spawn failed: ${String(e)}` });
      this.send(sock, { t: "exit", turnId, code: -1 });
      return;
    }
    const turn: Turn = { turnId, child, lines: [], exitCode: undefined, exited: false, subscribers: new Set([sock]) };
    this.turns.set(turnId, turn);

    const splitter = makeNdjsonSplitter((line) => {
      turn.lines.push(line);
      const seq = turn.lines.length;
      this.broadcast(turn, { t: "line", turnId, seq, line });
    });
    child.stdout.on("data", (d) => splitter.push(d));
    child.stderr.on("data", (d) => {
      const text = d.toString().trim();
      if (text) this.broadcast(turn, { t: "stderr", turnId, text });
    });
    child.on("exit", (code) => {
      splitter.flush();
      turn.exited = true;
      turn.exitCode = code;
      this.broadcast(turn, { t: "exit", turnId, code });
    });
    child.on("error", (err) => {
      this.broadcast(turn, { t: "stderr", turnId, text: `child error: ${String(err)}` });
      if (!turn.exited) {
        turn.exited = true;
        turn.exitCode = -1;
        this.broadcast(turn, { t: "exit", turnId, code: -1 });
      }
    });
  }

  // Subscribe a (re)connecting client and replay everything it has not seen:
  // buffered lines with seq > fromSeq, then a past exit if the turn already ended.
  private attachTurn(sock: Socket, turnId: string, fromSeq: number): void {
    const turn = this.turns.get(turnId);
    if (!turn) return; // not live — the web server will reset it to idle(interrupted)
    turn.subscribers.add(sock);
    for (let i = fromSeq; i < turn.lines.length; i++) {
      this.send(sock, { t: "line", turnId, seq: i + 1, line: turn.lines[i] });
    }
    if (turn.exited) this.send(sock, { t: "exit", turnId, code: turn.exitCode ?? null });
  }

  private broadcast(turn: Turn, msg: ServerMsg): void {
    for (const sock of turn.subscribers) this.send(sock, msg);
  }
}

const socketPath = process.env.RUNNER_SOCKET || DEFAULT_RUNNER_SOCKET;
const daemon = new RunnerDaemon(socketPath);
daemon.listen();

// Keep the process up; on a signal, exit cleanly (systemd restarts us). Children
// share our cgroup, so a daemon restart DOES end in-flight turns — that is the
// rare runner-update path and must be drained before restarting.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[runner] ${sig} — exiting`);
    process.exit(0);
  });
}
