import { createHash, randomUUID } from "node:crypto";
import type { MessageAction, MessageQueue, MessageSettings, PendingMessage, SubmitMessage } from "@palmagent/shared";
import type { Db } from "./db.js";

const EDIT_MS = 60_000;
interface StoredMessage extends PendingMessage { fingerprint: string; editToken?: string }
export interface MessageState extends Omit<MessageQueue, "messages"> {
  messages: StoredMessage[];
  protocol?: "interactive";
  initialMessageId?: string;
  runtimeStarted?: boolean;
}
interface Host {
  assertWritable(id: string): void;
  canStart(id: string): boolean;
  settings(id: string): MessageSettings;
  start(id: string, message: PendingMessage): void;
  steer(id: string, message: PendingMessage): Promise<"delivered" | "rejected" | "unknown">;
  changed(id: string): void;
}
export class MessageConflict extends Error { readonly status = 409 }
const conflict = (s: string): never => { throw new MessageConflict(s); };

// One controller owns ordering for both agents. Synchronous SQLite transitions
// claim work before any asynchronous adapter call; callbacks always re-read it.
export class MessageController {
  private timer: ReturnType<typeof setInterval>;
  constructor(private db: Db, private host: Host) {
    this.timer = setInterval(() => { if (!this.db.isOpen) { this.close(); return; } for (const id of this.db.messageTaskIds()) this.pump(id); }, 1000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  state(id: string): MessageState {
    return this.db.readMessageState(id) ?? { revision: 0, paused: false, runId: null, messages: [] };
  }
  snapshot(id: string): MessageQueue {
    const s = this.state(id);
    return { revision: s.revision, paused: s.paused, runId: s.runId,
      messages: s.messages.filter(m => !["delivered", "cancelled"].includes(m.status)).map(({ fingerprint: _, editToken: __, ...m }) => m) };
  }
  private save(id: string, s: MessageState) {
    s.revision++;
    this.db.writeMessageState(id, s);
    this.host.changed(id);
  }
  beginRun(id: string, initialMessageId?: string) {
    const s = this.state(id);
    s.runId = randomUUID(); s.initialMessageId = initialMessageId; s.runtimeStarted = false;
    for (const m of s.messages) if (m.status === "sending" && !m.runId) m.runId = s.runId;
    s.protocol = "interactive";
    this.save(id, s);
    return s.runId;
  }
  startingRuntime(id: string) { const s = this.state(id); s.runtimeStarted = true; this.save(id, s); }
  stopWaiting(id: string) {
    const s = this.state(id);
    const m = s.messages.find(m => m.id === s.initialMessageId);
    if (!s.runtimeStarted && m?.status === "sending") { m.status = "queued"; m.runId = undefined; }
    s.runId = null; s.paused = true; this.save(id, s);
  }
  recover(id: string, live: boolean) {
    const s = this.state(id);
    // A send may have crossed the process boundary before the server died.
    // Never replay it merely because its acknowledgement was lost.
    for (const m of s.messages) if (m.status === "sending") { if (!live && !s.runtimeStarted && m.id === s.initialMessageId) { m.status = "queued"; m.runId = undefined; continue; } m.status = "unknown"; m.error = "Delivery could not be confirmed after reconnecting."; s.paused = true; }
    if (!live && s.runId) { s.runId = null; s.paused = true; }
    this.save(id, s);
  }
  pause(id: string) { const s = this.state(id); s.paused = true; this.save(id, s); }
  resume(id: string) {
    this.host.assertWritable(id);
    const s = this.state(id);
    if (s.messages.some(m => m.status === "unknown" || m.status === "sending")) conflict("Resolve unconfirmed delivery before resuming the queue.");
    s.paused = false; this.save(id, s); this.pump(id);
    return this.snapshot(id);
  }
  finish(id: string, failed: boolean, drain = true) {
    const s = this.state(id); s.runId = null;
    if (failed) s.paused = true;
    for (const m of s.messages) if (m.status === "sending") { m.status = "unknown"; m.error = "The run ended before delivery was confirmed."; s.paused = true; }
    this.save(id, s);
    if (!failed && drain) this.pump(id);
  }
  delivered(id: string, messageId: string) {
    const s = this.state(id), m = s.messages.find(m => m.id === messageId);
    if (!m || !["sending", "unknown"].includes(m.status)) return;
    m.status = "delivered"; m.error = undefined; this.save(id, s);
  }
  submit(id: string, req: SubmitMessage) {
    this.host.assertWritable(id);
    const s = this.state(id), fingerprint = createHash("sha256").update(JSON.stringify(req)).digest("hex");
    const old = s.messages.find(m => m.id === req.clientMessageId);
    if (old) { if (old.fingerprint !== fingerprint) conflict("This message ID was already used with different content."); return this.snapshot(id); }
    if (s.messages.filter(m => m.status !== "delivered" && m.status !== "cancelled").length >= 100) conflict("The message queue is full.");
    if (req.mode === "send" && req.expectedRunId !== s.runId) conflict("The active run changed. Review the message and send again.");
    if (req.mode === "send") {
      if (s.messages.some(x => x.status === "sending" || x.status === "unknown")) conflict("Wait for the previous message delivery to be confirmed.");
      if (!s.runId && !this.host.canStart(id)) conflict("The task cannot start a new run yet.");
    }
    const m: StoredMessage = { id: req.clientMessageId, version: 1, mode: req.mode, text: req.text, images: req.images,
      settings: { ...this.host.settings(id), ...req.settings }, status: "queued", fingerprint };
    if (req.mode === "send" && s.runId && req.settings && Object.keys(req.settings).length) conflict("Model and permission changes apply to queued messages or the next run.");
    s.messages.push(m); this.save(id, s);
    if (req.mode === "send") this.sendNow(id, m.id);
    else this.pump(id);
    return this.snapshot(id);
  }
  action(id: string, messageId: string, action: MessageAction) {
    this.host.assertWritable(id);
    const s = this.state(id), m = s.messages.find(m => m.id === messageId);
    if (!m) conflict("Message not found.");
    const entry = m!;
    if ("version" in action && action.version !== entry.version) conflict("This message changed. Reload it before editing.");
    if (action.action === "delete") {
      if (entry.status === "sending" || entry.status === "delivered") conflict("The message has already been sent.");
      if (entry.editToken && (entry.editingUntil ?? 0) > Date.now()) conflict("This message is being edited.");
      entry.status = "cancelled";
    } else if (action.action === "send") {
      if (entry.status !== "queued") conflict("Only waiting messages can be sent.");
      if (entry.editToken && (entry.editingUntil ?? 0) > Date.now()) conflict("Finish editing before sending.");
      if (action.expectedRunId !== s.runId) conflict("The active run changed. Try again.");
      this.sendNow(id, messageId); return this.snapshot(id);
    } else {
      if (entry.status !== "queued") conflict("This message is no longer waiting.");
      if (action.action === "edit") {
        if (entry.editToken && entry.editToken !== action.token && (entry.editingUntil ?? 0) > Date.now()) conflict("This message is being edited on another device.");
        entry.editToken = action.token; entry.editingUntil = Date.now() + EDIT_MS;
      } else {
        if (entry.editToken !== action.token || (entry.editingUntil ?? 0) <= Date.now()) conflict("The edit session expired. Your draft is preserved; reopen the message.");
        if (action.action === "renew") entry.editingUntil = Date.now() + EDIT_MS;
        else {
          if (action.action === "save") { entry.text = action.text; entry.images = action.images; entry.version++; }
          delete entry.editToken; delete entry.editingUntil;
        }
      }
    }
    this.save(id, s); this.pump(id); return this.snapshot(id);
  }
  private sendNow(id: string, messageId: string) {
    const s = this.state(id), m = s.messages.find(m => m.id === messageId)!;
    if (s.messages.some(x => x.status === "sending" || x.status === "unknown")) conflict("Wait for the previous message delivery to be confirmed.");
    if (!s.runId && !this.host.canStart(id)) conflict("The task cannot start a new run yet.");
    m.status = "sending"; m.mode = "send"; m.runId = s.runId ?? undefined;
    this.save(id, s);
    if (!s.runId) { this.host.start(id, m); return; }
    void this.host.steer(id, m).then(status => {
      const current = this.state(id), entry = current.messages.find(x => x.id === messageId)!;
      if (entry.status === "delivered") return;
      entry.status = status;
      if (status !== "delivered") { entry.error = status === "unknown" ? "Delivery could not be confirmed. Check the conversation before sending again." : "The active run could not accept this message."; current.paused = true; }
      this.save(id, current);
    }, () => {
      const current = this.state(id), entry = current.messages.find(x => x.id === messageId)!;
      if (entry.status !== "delivered") { entry.status = "unknown"; entry.error = "Delivery could not be confirmed."; current.paused = true; this.save(id, current); }
    });
  }
  pump(id: string) {
    const s = this.state(id);
    if (s.paused || s.runId || !this.host.canStart(id)) return;
    if (s.messages.some(m => m.status === "sending" || m.status === "unknown" || m.status === "rejected")) return;
    const next = s.messages.find(m => m.status === "queued");
    if (!next || (next.editingUntil ?? 0) > Date.now()) return;
    next.status = "sending"; this.save(id, s); this.host.start(id, next);
  }
}
