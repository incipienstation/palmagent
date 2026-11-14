import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Readable } from "node:stream";
import type { MiddlewareHandler } from "hono";
import type { ViewControl, ViewStatus } from "../../application/ports/inbound/view-control.js";

type Worker = { child: ChildProcess; directory: string; socket: string; ready: boolean; started: number };
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/** The retained API owns this disposable, database-free static-file process.
 * The IPC pipe is a parent lease: losing the owner also terminates the view. */
export class ViewHost implements ViewControl {
  private worker?: Worker;
  private operation?: Promise<ViewStatus>;
  private closing = false;
  private closePromise?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private generation = 0;

  constructor(private readonly options: { entry: string; execArgv: string[]; staticDir: string }) {}

  status(): ViewStatus {
    return { protocol: 1, ownerPid: process.pid, generation: this.generation,
      state: this.closing ? "stopped" : this.worker?.ready ? "ready" : this.operation ? "starting" : "unavailable",
      ...(this.worker && !exited(this.worker.child) ? { pid: this.worker.child.pid } : {}) };
  }

  restart(): Promise<ViewStatus> {
    if (this.closing) return Promise.reject(new Error("View host is shutting down"));
    if (this.operation) return this.operation;
    clearTimeout(this.retry);
    this.retry = undefined;
    const operation = (async () => {
      await this.stopWorker();
      if (this.closing) throw new Error("View host is shutting down");
      await this.startWorker();
      return this.status();
    })();
    this.operation = operation;
    void operation.then(() => {
      this.operation = undefined;
    }, () => {
      this.operation = undefined;
      this.scheduleRecovery();
    });
    return operation;
  }

  private scheduleRecovery(): void {
    if (this.closing || this.retry || this.operation || this.worker?.ready) return;
    const backoff = Math.min(1000 * 2 ** Math.min(this.failures++, 5), 30_000);
    this.retry = setTimeout(() => { this.retry = undefined; void this.restart().catch(() => {}); }, backoff);
    this.retry.unref();
  }

  private async startWorker(): Promise<void> {
    const directory = mkdtempSync(join(tmpdir(), "palmagent-view-"));
    const socket = join(directory, "http.sock");
    // No database paths, provider credentials or host-readiness capability cross this boundary.
    const child = spawn(process.execPath, [...this.options.execArgv, this.options.entry, socket, this.options.staticDir], {
      env: { NODE_ENV: "production", ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const worker: Worker = { child, directory, socket, ready: false, started: Date.now() };
    this.worker = worker;
    const remove = () => {
      rmSync(directory, { recursive: true, force: true });
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (worker.ready && Date.now() - worker.started >= 30_000) this.failures = 0;
      this.scheduleRecovery();
    };
    child.once("exit", remove);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => failed(new Error("View readiness timed out")), 10_000);
        const cleanup = () => { clearTimeout(timeout); child.off("message", ready); child.off("error", failed); child.off("exit", ended); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        const ended = () => failed(new Error("View exited before readiness"));
        const ready = (message: unknown) => {
          if (!message || typeof message !== "object" || !("ready" in message) || message.ready !== 1) return;
          cleanup(); worker.ready = true; this.generation++; resolve();
        };
        child.on("message", ready); child.once("error", failed); child.once("exit", ended);
      });
    } catch (error) {
      await this.stopWorker();
      throw error;
    }
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    worker.ready = false;
    if (!exited(worker.child) && worker.child.pid) {
      await new Promise<void>(resolve => {
        const timeout = setTimeout(() => worker.child.kill("SIGKILL"), 3000);
        worker.child.once("exit", () => { clearTimeout(timeout); resolve(); });
        worker.child.kill("SIGTERM");
      });
    }
    if (this.worker === worker) this.worker = undefined;
    rmSync(worker.directory, { recursive: true, force: true });
  }

  close(): Promise<void> {
    this.closing = true;
    clearTimeout(this.retry);
    return this.closePromise ??= (async () => {
      await this.operation?.catch(() => {});
      await this.stopWorker();
    })();
  }

  proxy(): MiddlewareHandler {
    return async (c, next) => {
      if (c.req.method !== "GET" || c.req.path.startsWith("/api/")) return next();
      const worker = this.worker;
      if (!worker?.ready || this.closing) return c.json({ error: "Web view is restarting" }, 503);
      const url = new URL(c.req.url);
      const headers: Record<string, string> = {};
      for (const name of ["range", "if-none-match", "if-modified-since", "accept-encoding"]) {
        const value = c.req.header(name); if (value) headers[name] = value;
      }
      try {
        return await new Promise<Response>((resolve, reject) => {
          const upstream = request({ socketPath: worker.socket, path: url.pathname + url.search, headers, timeout: 10_000 }, response => {
            const out = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined && !["connection", "keep-alive", "transfer-encoding"].includes(name)) out.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            const status = response.statusCode ?? 502;
            const body = [204, 205, 304].includes(status) ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
            if (!body) response.resume();
            resolve(new Response(body, { status, headers: out }));
          });
          const abort = () => upstream.destroy(new Error("View request aborted"));
          c.req.raw.signal.addEventListener("abort", abort, { once: true });
          upstream.once("close", () => c.req.raw.signal.removeEventListener("abort", abort));
          upstream.once("timeout", () => upstream.destroy(new Error("View request timed out")));
          upstream.once("error", reject);
          upstream.end();
        });
      } catch {
        return c.json({ error: "Web view is temporarily unavailable" }, 503);
      }
    };
  }
}
