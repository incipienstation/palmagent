import * as headless from "@xterm/headless";
import * as serialize from "@xterm/addon-serialize";
import { TerminalClientFrame, type TerminalFrame, type TerminalInput } from "@palmagent/shared/terminals";
import type { LocalChannel, TerminalDriver, ShellResolver } from "./platform.js";
import type { TerminalRecord } from "./store.js";

// Node's CJS namespace and the bundled UMD namespace expose different defaults.
const { Terminal } = (headless as typeof headless & { default?: typeof headless }).default ?? headless;
const { SerializeAddon } = (serialize as typeof serialize & { default?: typeof serialize }).default ?? serialize;
/** Owns terminal state independently of any client. All clients start with an atomic snapshot. */
export class TerminalHost {
  private screen: InstanceType<typeof Terminal>;
  private serializer = new SerializeAddon();
  private process;
  private clients = new Set<LocalChannel>();
  private ready = new Set<LocalChannel>();
  private writer?: LocalChannel;
  private epoch = 0;
  private seq = 0;
  private pending = 0;
  private ended = false;
  private tail = Promise.resolve();
  private acknowledgements = new Map<LocalChannel, number>();
  constructor(record: TerminalRecord, driver: TerminalDriver, shell: ShellResolver, private onExit: (code: number) => void) {
    this.screen = new Terminal({ cols: record.cols, rows: record.rows, scrollback: 2000, allowProposedApi: true });
    this.screen.loadAddon(this.serializer);
    this.process = driver.spawn(shell.resolve(), record.initialCwd, record.cols, record.rows);
    // Only the authoritative emulator answers terminal queries. Viewers never send replies.
    this.screen.onData(data => this.process.write(data));
    this.process.onOutput(data => {
      this.pending += data.length;
      if (this.pending > 256_000) this.process.pause();
      this.enqueue(async () => {
        await new Promise<void>(resolve => this.screen.write(data, resolve));
        this.seq++;
        this.broadcast({ type: "output", data, seq: this.seq });
        this.pending -= data.length;
        if (this.pending < 64_000) this.process.resume();
      });
    });
    this.process.onExit(code => this.enqueue(() => {
      this.ended = true; this.broadcast({ type: "exit", exitCode: code }); this.onExit(code);
    }));
  }
  private enqueue(fn: () => void | Promise<void>) { this.tail = this.tail.then(fn).catch(() => this.terminate()); }
  attach(channel: LocalChannel) {
    if (this.clients.size >= 8 || this.ended) { channel.close(); return; }
    this.clients.add(channel);
    this.acknowledgements.set(channel, this.seq);
    channel.onClose(() => {
      this.clients.delete(channel); this.ready.delete(channel); this.acknowledgements.delete(channel);
      if (this.writer === channel) { this.writer = undefined; this.epoch++; this.controls(); }
    });
    channel.onMessage(value => {
      const parsed = TerminalClientFrame.safeParse(value);
      if (!parsed.success || parsed.data.type === "attach") { channel.close(); return; }
      this.enqueue(() => { if (this.clients.has(channel)) this.input(channel, parsed.data as TerminalInput); });
    });
    this.enqueue(() => {
      if (!this.clients.has(channel)) return;
      channel.send({ type: "snapshot", data: this.serializer.serialize(), seq: this.seq, cols: this.screen.cols, rows: this.screen.rows } satisfies TerminalFrame);
      this.acknowledgements.set(channel, this.seq);
      this.ready.add(channel);
      // An explicit claim is always required; reconnect does not steal control.
      this.controls();
    });
  }
  private input(channel: LocalChannel, frame: TerminalInput) {
    if (frame.type === "ack") {
      if (frame.seq <= this.seq) this.acknowledgements.set(channel, Math.max(frame.seq, this.acknowledgements.get(channel) ?? 0));
    } else if (frame.type === "claim-control") {
      this.writer = channel; this.epoch++; this.controls();
    } else if (frame.type === "release-control") {
      if (this.writer === channel) { this.writer = undefined; this.epoch++; this.controls(); }
    } else if (this.writer === channel && frame.epoch === this.epoch) {
      if (frame.type === "input") this.process.write(frame.data);
      else {
        this.screen.resize(frame.cols, frame.rows); this.process.resize(frame.cols, frame.rows);
        this.seq++; this.broadcast({ type: "resize", cols: frame.cols, rows: frame.rows, seq: this.seq });
      }
    }
  }
  private controls() {
    for (const channel of this.ready) channel.send({ type: "control", writable: channel === this.writer, epoch: this.epoch } satisfies TerminalFrame);
  }
  private broadcast(frame: TerminalFrame) {
    for (const channel of this.ready) {
      if (this.seq - (this.acknowledgements.get(channel) ?? 0) > 512) channel.close();
      else channel.send(frame);
    }
  }
  async isReady(): Promise<boolean> { await this.tail; return !this.ended; }
  terminate() { if (!this.ended) this.process.terminate(); }
  close() { for (const channel of this.clients) channel.close(); this.screen.dispose(); }
}
