import type { Attachment, MessageAction, MessageQueue, SubmitMessage } from "@palmagent/shared";
import { ApplicationError } from "../../../kernel/errors.js";
import type { MessageState, StoredMessage } from "./models.js";

const EDIT_MS = 60_000;
export class MessageConflict extends ApplicationError {
  constructor(message: string) { super("conflict", message); }
}
const conflict = (message: string): never => { throw new MessageConflict(message); };

// Apply at state load/save boundaries. Pause protects pending messages, not
// future submissions. Sending, rejected and unknown entries remain pending.
export function clearEmptyQueuePause(state: MessageState): void {
  if (!state.messages.some(message => message.status !== "delivered" && message.status !== "cancelled")) state.paused = false;
}

// Mutates an exclusively owned state snapshot. The caller persists it before
// executing effects. Time, identity and execution availability are explicit facts;
// this policy performs no I/O and does not advance the persistence revision.
export class MessagePolicy {
  constructor(readonly state: MessageState) {}

  snapshot(): MessageQueue {
    const s = this.state;
    return { revision: s.revision, paused: s.paused, runId: s.runId, ...(s.compaction ? { compaction: s.compaction } : {}),
      messages: s.messages.filter(m => !["delivered", "cancelled"].includes(m.status)).map(({ fingerprint: _, editToken: __, ...m }) => m) };
  }
  beginRun(runId: string, initialMessageId?: string, compactionRequestId?: string) {
    const s = this.state;
    s.runId = runId; s.initialMessageId = initialMessageId; s.runtimeStarted = false;
    s.compaction = compactionRequestId ? { requestId: compactionRequestId, status: "running" } : undefined;
    for (const m of s.messages) if (m.status === "sending" && !m.runId) m.runId = s.runId;
    s.protocol = "interactive";
    return s.runId;
  }
  rejectBeforeStart(error: string) {
    const s = this.state;
    if (s.runtimeStarted) return false;
    for (const m of s.messages) if (m.status === "sending") { m.status = "rejected"; m.error = error; }
    s.runId = null; s.paused = true;
    return true;
  }
  startingRuntime() { const s = this.state; s.runtimeStarted = true; }
  stopWaiting() {
    const s = this.state;
    const m = s.messages.find(m => m.id === s.initialMessageId);
    if (!s.runtimeStarted && m?.status === "sending") { m.status = "queued"; m.runId = undefined; }
    s.runId = null; s.paused = true;
    if (s.compaction?.status === "running") s.compaction = { ...s.compaction, status: "failed", error: "Context compaction was stopped." };
  }
  recover(live: boolean) {
    const s = this.state;
    // A send may have crossed the process boundary before the server died.
    // Never replay it merely because its acknowledgement was lost.
    for (const message of s.messages) {
      if (message.status !== "sending") continue;
      if (!live && !s.runtimeStarted && message.id === s.initialMessageId) {
        message.status = "queued"; message.runId = undefined;
        continue;
      }
      message.status = "unknown";
      message.error = "Delivery could not be confirmed after reconnecting.";
      s.paused = true;
    }
    if (!live && s.runId) { s.runId = null; s.paused = true; }
    if (!live && s.compaction?.status === "running") s.compaction = { ...s.compaction, status: "failed", error: "Context compaction could not be confirmed after restarting. You can try again." };
  }
  pause() { const s = this.state; s.paused = true; }
  resume() {
    const s = this.state;
    if (s.messages.some(m => m.status === "unknown" || m.status === "sending")) conflict("Resolve unconfirmed delivery before resuming the queue.");
    s.paused = false;
  }
  finish(failed: boolean, error?: string) {
    const s = this.state; s.runId = null;
    if (s.compaction?.status === "running") {
      s.compaction = { ...s.compaction, status: failed ? "failed" : "completed",
        ...(failed ? { error: error ?? "Context compaction did not finish. Try again." } : {}) };
    }
    if (failed) s.paused = true;
    for (const message of s.messages) {
      if (message.status !== "sending") continue;
      message.status = "unknown";
      message.error = "The run ended before delivery was confirmed.";
      s.paused = true;
    }
  }
  delivered(messageId: string) {
    const s = this.state, m = s.messages.find(m => m.id === messageId);
    if (!m || !["sending", "unknown"].includes(m.status)) return false;
    m.status = "delivered"; m.error = undefined;
    return true;
  }
  deliveryFailed(messageId: string, status: "rejected" | "unknown") {
    const state = this.state, entry = state.messages.find(message => message.id === messageId);
    if (!entry || entry.status === "delivered") return false;
    entry.status = status;
    entry.error = status === "rejected" ? "The shared session rejected this message." : "Delivery could not be confirmed. Check the conversation before sending again.";
    state.paused = true;
    return true;
  }
  hasSubmission(messageId: string, fingerprint: string): boolean {
    const old = this.state.messages.find(m => m.id === messageId);
    if (!old) return false;
    if (old.fingerprint !== fingerprint) conflict("This message ID was already used with different content.");
    return true;
  }
  assertSubmission(req: SubmitMessage, canStart: boolean) {
    const s = this.state;
    if (s.messages.filter(m => m.status !== "delivered" && m.status !== "cancelled").length >= 100) conflict("The message queue is full.");
    if (req.mode === "send" && req.expectedRunId !== s.runId) conflict("The active run changed. Review the message and send again.");
    if (req.mode === "send") this.assertCanSend(canStart);
    if (req.mode === "send" && s.runId && req.settings && Object.keys(req.settings).length) conflict("Model and permission changes apply to queued messages or the next run.");
  }
  enqueue(message: StoredMessage) { this.state.messages.push(message); }

  checkAction(messageId: string, action: MessageAction, now: number): StoredMessage {
    const entry = this.state.messages.find(m => m.id === messageId);
    if (!entry) return conflict("Message not found.");
    if ("version" in action && action.version !== entry.version) conflict("This message changed. Reload it before editing.");
    const editing = !!entry.editToken && (entry.editingUntil ?? 0) > now;
    if (action.action === "delete") {
      if (entry.status === "sending" || entry.status === "delivered") conflict("The message has already been sent.");
      if (editing) conflict("This message is being edited.");
    } else if (action.action === "send") {
      if (entry.status !== "queued") conflict("Only waiting messages can be sent.");
      if (editing) conflict("Finish editing before sending.");
      if (action.expectedRunId !== this.state.runId) conflict("The active run changed. Try again.");
    } else {
      if (entry.status !== "queued") conflict("This message is no longer waiting.");
      if (action.action === "edit") {
        if (editing && entry.editToken !== action.token) conflict("This message is being edited on another device.");
      } else if (entry.editToken !== action.token || (entry.editingUntil ?? 0) <= now) {
        conflict("The edit session expired. Your draft is preserved; reopen the message.");
      }
    }
    return entry;
  }
  // Apply only after checkAction succeeds and attachment effects have completed.
  applyAction(entry: StoredMessage, action: Exclude<MessageAction, { action: "send" }>, now: number, attachments?: Attachment[]) {
    if (action.action === "delete") entry.status = "cancelled";
    else if (action.action === "edit") {
      entry.editToken = action.token; entry.editingUntil = now + EDIT_MS;
    } else if (action.action === "renew") entry.editingUntil = now + EDIT_MS;
    else {
      if (action.action === "save") {
        entry.text = action.text; entry.attachments = attachments; delete entry.images;
        entry.skills = action.skills; entry.version++;
      }
      delete entry.editToken; delete entry.editingUntil;
    }
  }
  private assertCanSend(canStart: boolean) {
    if (this.state.messages.some(m => m.status === "sending" || m.status === "unknown")) conflict("Wait for the previous message delivery to be confirmed.");
    if (!this.state.runId && !canStart) conflict("The task cannot start a new run yet.");
  }
  claimSend(messageId: string, canStart: boolean): StoredMessage {
    this.assertCanSend(canStart);
    const m = this.state.messages.find(m => m.id === messageId)!;
    m.status = "sending"; m.mode = "send"; m.runId = this.state.runId ?? undefined;
    return m;
  }
  claimNext(canStart: boolean, now: number): StoredMessage | undefined {
    const s = this.state;
    if (s.paused || s.runId || !canStart) return;
    if (s.messages.some(m => m.status === "sending" || m.status === "unknown" || m.status === "rejected")) return;
    const next = s.messages.find(m => m.status === "queued");
    if (!next || (next.editingUntil ?? 0) > now) return;
    next.status = "sending";
    return next;
  }
  settleSteer(messageId: string, status: "delivered" | "rejected" | "unknown", promiseRejected = false): boolean {
    const entry = this.state.messages.find(m => m.id === messageId)!;
    if (entry.status === "delivered") return false;
    entry.status = status;
    if (status !== "delivered") {
      entry.error = promiseRejected ? "Delivery could not be confirmed." : status === "unknown"
        ? "Delivery could not be confirmed. Check the conversation before sending again." : "The active run could not accept this message.";
      this.state.paused = true;
    }
    return true;
  }
  rejectStart(messageId: string, error: string): boolean {
    const entry = this.state.messages.find(m => m.id === messageId);
    if (this.state.runId || entry?.status !== "sending") return false;
    entry.status = "rejected"; entry.error = error; this.state.paused = true;
    return true;
  }
}
