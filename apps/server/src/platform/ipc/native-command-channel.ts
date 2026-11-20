import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Blocking owner calls preserve synchronous transaction and callback ordering in the API.
 * Both pipes are unlinked before startup completes. EOF releases the child lease on API exit. */
export class NativeCommandChannel {
  private child: ChildProcess;
  private exited: Promise<void>;
  private input: number;
  private output: number;
  private closed = false;
  private busy = false;
  private readonly idle = new Int32Array(new SharedArrayBuffer(4));

  constructor(binary: string, args: string[], lease: number) {
    const directory = mkdtempSync(join(tmpdir(), "palmagent-ipc-"));
    const opened = new Set<number>();
    const open = (path: string, flags: number) => {
      const fd = openSync(path, flags);
      opened.add(fd);
      return fd;
    };
    try {
      const request = join(directory, "request"), reply = join(directory, "reply");
      execFileSync("mkfifo", ["-m", "600", request, reply]);
      // The temporary O_RDWR descriptors allow opening each end without waiting
      // for its peer. Closing both anchors restores ordinary broken-pipe semantics.
      open(request, constants.O_RDWR);
      open(reply, constants.O_RDWR);
      const childInput = open(request, constants.O_RDONLY);
      const childOutput = open(reply, constants.O_WRONLY);
      this.input = open(request, constants.O_WRONLY | constants.O_NONBLOCK);
      this.output = open(reply, constants.O_RDONLY | constants.O_NONBLOCK);
      this.child = spawn(binary, args, { stdio: [childInput, childOutput, "inherit", lease] });
      this.exited = new Promise(resolve => this.child.once("close", () => resolve()));
      this.child.on("error", () => { void this.close(); });
      opened.delete(this.input);
      opened.delete(this.output);
    } finally {
      for (const fd of opened) closeSync(fd);
      rmSync(directory, { recursive: true, force: true });
    }
  }

  request(body: object, project?: (input: unknown) => object): unknown {
    if (this.closed) throw new Error("Native Task owner channel is closed");
    if (this.busy) throw new Error("Unexpected nested Task command during projection");
    this.busy = true;
    let renderingFailed = false, renderingError: unknown;
    try {
      const deadline = performance.now() + 30_000;
      const send = (message: object) => this.transfer(Buffer.from(JSON.stringify(message) + "\n"), deadline, true);
      send(body);
      for (;;) {
        const header = Buffer.allocUnsafe(4);
        this.transfer(header, deadline, false);
        const reply = Buffer.allocUnsafe(header.readUInt32BE());
        this.transfer(reply, deadline, false);
        const frame = JSON.parse(reply.toString("utf8"));
        if (!Object.hasOwn(frame, "project")) {
          if (renderingFailed) throw renderingError;
          return frame;
        }
        let projection: object;
        try {
          if (!project) throw new Error("Unexpected projection request");
          projection = project(frame.project);
        } catch (error) {
          renderingFailed = true;
          renderingError = error;
          projection = { failed: true };
        }
        send(projection);
      }
    } catch (error) {
      if (renderingFailed && error === renderingError) throw error;
      this.child.kill("SIGKILL");
      void this.close();
      throw error;
    } finally { this.busy = false; }
  }

  private transfer(buffer: Buffer, deadline: number, writing: boolean): void {
    let offset = 0, waitMs = 0.1;
    while (offset < buffer.length) {
      if (performance.now() >= deadline) throw new Error("Native Task owner timed out before its receipt");
      try {
        const count = writing
          ? writeSync(this.input, buffer, offset, buffer.length - offset)
          : readSync(this.output, buffer, offset, buffer.length - offset, null);
        if (!count) throw new Error("Native Task owner closed before its receipt");
        offset += count;
        waitMs = 0.1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
        Atomics.wait(this.idle, 0, 0, waitMs);
        waitMs = Math.min(waitMs * 2, 5);
      }
    }
  }

  close(): Promise<void> {
    if (this.closed) return this.exited;
    this.closed = true;
    closeSync(this.input);
    closeSync(this.output);
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 5_000).unref();
    void this.exited.then(() => clearTimeout(timer));
    return this.exited;
  }
}
