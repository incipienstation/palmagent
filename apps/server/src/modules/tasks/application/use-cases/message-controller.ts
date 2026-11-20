import type { IdentifierGenerator } from "../../../../kernel/identifiers.js";
import type { MessageAction, MessageQueue, MessageSettings, PendingMessage, SubmitMessage } from "@palmagent/shared";
import type { QueueOperation, QueueReceipt, RetainedTurns } from "../ports/outbound/retained-turns.js";
import type { MessageState, StoredMessage } from "../../domain/models.js";
import { clearEmptyQueuePause, MessagePolicy } from "../../domain/message-policy.js";
import type { AttachmentStorage } from "../ports/outbound/attachments.js";
import type { MessageStateRepository } from "../ports/outbound/persistence.js";
import type { MessageTiming } from "../ports/outbound/message-timing.js";
export { MessageConflict } from "../../domain/message-policy.js";

interface Host {
  assertWritable(id: string): void;
  validateSubmission?(id: string, req: SubmitMessage): void;
  canStart(id: string): boolean;
  settings(id: string): MessageSettings;
  start(id: string, message: PendingMessage): void;
  steer(id: string, message: PendingMessage): Promise<"delivered" | "rejected" | "unknown">;
  changed(id: string): void;
}

// One controller owns ordering for both agents. Persist claims synchronously
// before calling the host; asynchronous receipts always load the current state.
export class MessageController {
  private closed = false;
  private readonly cancelPolling: () => void;
  constructor(private db: MessageStateRepository, private host: Host, private attachments: AttachmentStorage,
    private readonly ids: IdentifierGenerator, private readonly timing: MessageTiming, private readonly native?: RetainedTurns) {
    this.cancelPolling = timing.every(1000, () => {
      if (this.closed) return;
      if (!this.db.isOpen) { this.close(); return; }
      for (const id of this.db.messageTaskIds()) this.pump(id);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.cancelPolling();
  }
  state(id: string): MessageState {
    const s = this.db.readMessageState(id) ?? { revision: 0, paused: false, runId: null, messages: [] };
    clearEmptyQueuePause(s); // Also normalize empty pauses saved by older versions.
    return s;
  }
  private policy(id: string) { return new MessagePolicy(this.state(id)); }
  snapshot(id: string): MessageQueue { return this.policy(id).snapshot(); }
  private apply(id: string, operation: QueueOperation, local: (policy: MessagePolicy) => boolean | void | StoredMessage,
    policy?: MessagePolicy, notify = true): QueueReceipt {
    if (this.native) {
      if (this.db.inTransaction) throw new Error("Queue writes require the native Task transaction");
      const receipt = this.native.queue(id, operation);
      if (receipt.changed && notify) this.host.changed(id);
      return receipt;
    }
    policy ??= this.policy(id);
    const result = local(policy), changed = result !== false;
    if (changed) {
      clearEmptyQueuePause(policy.state);
      policy.state.revision++;
      this.db.writeMessageState(id, policy.state);
      if (notify) this.host.changed(id);
    }
    return { changed, runId: policy.state.runId, claimed: typeof result === "object" ? result : undefined };
  }
  beginRun(id: string, initialMessage?: string, compaction?: string, retained = false) {
    const runId = this.ids.uuid();
    this.apply(id, { kind: "beginRun", id: runId, initialMessage, compaction, retained },
      policy => { policy.beginRun(runId, initialMessage, compaction, retained); });
    return runId;
  }
  rejectBeforeStart(id: string, error: string) {
    this.apply(id, { kind: "rejectBeforeStart", error }, policy => policy.rejectBeforeStart(error));
  }
  startingRuntime(id: string) {
    this.apply(id, { kind: "sharedRuntimeStarted" }, policy => policy.startingRuntime());
  }
  stopWaiting(id: string) { this.apply(id, { kind: "stopWaiting" }, policy => policy.stopWaiting()); }
  recover(id: string, live: boolean) { this.apply(id, { kind: "recover", live }, policy => policy.recover(live)); }
  pause(id: string) { this.apply(id, { kind: "pause" }, policy => policy.pause()); }
  resume(id: string) {
    this.host.assertWritable(id);
    this.apply(id, { kind: "resume" }, policy => policy.resume());
    this.pump(id);
    return this.snapshot(id);
  }
  finish(id: string, failed: boolean, drain = true, error?: string, notify = true) {
    this.apply(id, { kind: "finish", failed, error }, policy => policy.finish(failed, error), undefined, notify);
    if (!failed && drain) this.pump(id);
  }
  delivered(id: string, messageId: string) {
    this.apply(id, { kind: "delivered", id: messageId }, policy => policy.delivered(messageId));
  }
  deliveryFailed(id: string, messageId: string, status: "rejected" | "unknown") {
    if (!this.closed) this.apply(id, { kind: "sharedDeliveryFailed", id: messageId, unknown: status === "unknown" },
      policy => policy.deliveryFailed(messageId, status));
  }
  submit(id: string, req: SubmitMessage) {
    const policy = this.policy(id), fingerprint = this.ids.digest(JSON.stringify(req));
    // A lost HTTP receipt reads the accepted submission, even during maintenance
    // or after ownership changes. It never sends the provider command again.
    if (policy.hasSubmission(req.clientMessageId, fingerprint)) return this.snapshot(id);
    this.host.assertWritable(id);
    this.host.validateSubmission?.(id, req);
    const canStart = req.mode !== "send" || !!policy.state.runId || this.host.canStart(id);
    policy.assertSubmission(req, canStart);
    const message: StoredMessage = { id: req.clientMessageId, version: 1, mode: req.mode, text: req.text,
      attachments: this.attachments.save(id, req.images), skills: req.skills,
      settings: { ...this.host.settings(id), ...req.settings }, status: "queued", fingerprint };
    const receipt = this.apply(id, { kind: "submit", message, canStart, expectedRunId: req.expectedRunId, hasSettings: !!req.settings && Object.keys(req.settings).length > 0 },
      current => { current.enqueue(message); }, policy);
    if (!receipt.changed) return this.snapshot(id);
    if (req.mode === "send") this.sendNow(id, req.clientMessageId);
    else this.pump(id);
    return this.snapshot(id);
  }
  action(id: string, messageId: string, action: MessageAction) {
    this.host.assertWritable(id);
    const policy = this.policy(id);
    const entry = policy.checkAction(messageId, action, this.timing.now());
    if (action.action === "send") {
      const canStart = !!policy.state.runId || this.host.canStart(id);
      const claim = this.apply(id, { kind: "act", id: messageId, action, now: this.timing.now(), canStart },
        current => current.claimSend(messageId, canStart), policy);
      this.dispatch(id, claim);
      return this.snapshot(id);
    }
    const editImages = action.action === "edit" ? this.attachments.load(id, entry.attachments) ?? entry.images : undefined;
    const attachments = action.action === "save" ? this.attachments.save(id, action.images) : undefined;
    const now = this.timing.now();
    const edit = action.action === "save" ? { ...action, images: undefined, attachments } : action;
    this.apply(id, { kind: "act", id: messageId, action: edit, now, canStart: false },
      current => current.applyAction(entry, action, now, attachments), policy);
    this.pump(id);
    const snapshot = this.snapshot(id);
    if (action.action === "edit") snapshot.messages = snapshot.messages.map(message => message.id === messageId ? { ...message, images: editImages } : message);
    return snapshot;
  }
  private sendNow(id: string, messageId: string) {
    const policy = this.policy(id);
    const canStart = !!policy.state.runId || this.host.canStart(id);
    this.dispatch(id, this.apply(id, { kind: "claimSend", id: messageId, canStart },
      current => current.claimSend(messageId, canStart), policy));
  }
  private dispatch(id: string, receipt: QueueReceipt) {
    const message = receipt.claimed;
    if (!message) throw new Error("Missing committed delivery claim");
    if (!receipt.runId) { this.start(id, message); return; }
    const settle = (delivery: "delivered" | "unknown" | "rejected" | "receiptLost") => {
      if (!this.closed) this.apply(id, { kind: "settleSteer", id: message.id, delivery },
        current => current.settleSteer(message.id, delivery === "receiptLost" ? "unknown" : delivery, delivery === "receiptLost"));
    };
    void this.host.steer(id, message).then(settle, () => settle("receiptLost"));
  }
  private start(id: string, message: PendingMessage) {
    try { this.host.start(id, message); }
    catch (error) {
      const reason = error instanceof Error ? error.message : "Unable to start message";
      if (!this.apply(id, { kind: "rejectStart", id: message.id, error: reason },
        policy => policy.rejectStart(message.id, reason)).changed) throw error;
    }
  }
  pump(id: string) {
    const policy = this.policy(id);
    if (policy.state.paused || policy.state.runId || !policy.state.messages.some(message => message.status === "queued") || !this.host.canStart(id)) return;
    const now = this.timing.now();
    const next = this.apply(id, { kind: "claimNext", canStart: true, now }, current => current.claimNext(true, now) ?? false, policy);
    if (next.claimed) this.start(id, next.claimed);
  }
}
