import type { IdentifierGenerator } from "../../../../kernel/identifiers.js";
import type { MessageAction, MessageQueue, MessageSettings, PendingMessage, SubmitMessage } from "@palmagent/shared";
import type { MessageState } from "../../domain/models.js";
import { MessagePolicy } from "../../domain/message-policy.js";
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
    private readonly ids: IdentifierGenerator, private readonly timing: MessageTiming) {
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
    return this.db.readMessageState(id) ?? { revision: 0, paused: false, runId: null, messages: [] };
  }
  private policy(id: string) { return new MessagePolicy(this.state(id)); }
  snapshot(id: string): MessageQueue { return this.policy(id).snapshot(); }
  private save(id: string, s: MessageState) {
    s.revision++;
    this.db.writeMessageState(id, s);
    this.host.changed(id);
  }
  private change(id: string, transition: (policy: MessagePolicy) => boolean | void) {
    const policy = this.policy(id);
    if (transition(policy) !== false) this.save(id, policy.state);
  }
  beginRun(id: string, initialMessageId?: string, compactionRequestId?: string) {
    const runId = this.ids.uuid();
    this.change(id, policy => { policy.beginRun(runId, initialMessageId, compactionRequestId); });
    return runId;
  }
  rejectBeforeStart(id: string, error: string) { this.change(id, policy => policy.rejectBeforeStart(error)); }
  startingRuntime(id: string) { this.change(id, policy => policy.startingRuntime()); }
  stopWaiting(id: string) { this.change(id, policy => policy.stopWaiting()); }
  recover(id: string, live: boolean) { this.change(id, policy => policy.recover(live)); }
  pause(id: string) { this.change(id, policy => policy.pause()); }
  resume(id: string) {
    this.host.assertWritable(id);
    this.change(id, policy => policy.resume());
    this.pump(id);
    return this.snapshot(id);
  }
  finish(id: string, failed: boolean, drain = true, error?: string) {
    this.change(id, policy => policy.finish(failed, error));
    if (!failed && drain) this.pump(id);
  }
  delivered(id: string, messageId: string) { this.change(id, policy => policy.delivered(messageId)); }
  deliveryFailed(id: string, messageId: string, status: "rejected" | "unknown") {
    if (!this.closed) this.change(id, policy => policy.deliveryFailed(messageId, status));
  }
  submit(id: string, req: SubmitMessage) {
    const policy = this.policy(id), fingerprint = this.ids.digest(JSON.stringify(req));
    // A lost HTTP receipt reads the accepted submission, even during maintenance
    // or after ownership changes. It never sends the provider command again.
    if (policy.hasSubmission(req.clientMessageId, fingerprint)) return this.snapshot(id);
    this.host.assertWritable(id);
    this.host.validateSubmission?.(id, req);
    policy.assertSubmission(req, req.mode !== "send" || !!policy.state.runId || this.host.canStart(id));
    policy.enqueue({ id: req.clientMessageId, version: 1, mode: req.mode, text: req.text,
      attachments: this.attachments.save(id, req.images), skills: req.skills,
      settings: { ...this.host.settings(id), ...req.settings }, status: "queued", fingerprint });
    this.save(id, policy.state);
    if (req.mode === "send") this.sendNow(id, req.clientMessageId);
    else this.pump(id);
    return this.snapshot(id);
  }
  action(id: string, messageId: string, action: MessageAction) {
    this.host.assertWritable(id);
    const policy = this.policy(id);
    const entry = policy.checkAction(messageId, action, this.timing.now());
    if (action.action === "send") { this.sendNow(id, messageId); return this.snapshot(id); }
    const editImages = action.action === "edit" ? this.attachments.load(id, entry.attachments) ?? entry.images : undefined;
    const attachments = action.action === "save" ? this.attachments.save(id, action.images) : undefined;
    policy.applyAction(entry, action, this.timing.now(), attachments);
    this.save(id, policy.state); this.pump(id);
    const snapshot = this.snapshot(id);
    if (action.action === "edit") snapshot.messages = snapshot.messages.map(message => message.id === messageId ? { ...message, images: editImages } : message);
    return snapshot;
  }
  private sendNow(id: string, messageId: string) {
    const policy = this.policy(id);
    const message = policy.claimSend(messageId, !!policy.state.runId || this.host.canStart(id));
    this.save(id, policy.state);
    if (!policy.state.runId) { this.start(id, message); return; }
    void this.host.steer(id, message).then(status => {
      if (!this.closed) this.change(id, current => current.settleSteer(messageId, status));
    }, () => {
      if (!this.closed) this.change(id, current => current.settleSteer(messageId, "unknown", true));
    });
  }
  private start(id: string, message: PendingMessage) {
    try { this.host.start(id, message); }
    catch (error) {
      const policy = this.policy(id);
      if (!policy.rejectStart(message.id, error instanceof Error ? error.message : "Unable to start message")) throw error;
      this.save(id, policy.state);
    }
  }
  pump(id: string) {
    const policy = this.policy(id);
    const next = policy.claimNext(!policy.state.paused && !policy.state.runId && this.host.canStart(id), this.timing.now());
    if (next) { this.save(id, policy.state); this.start(id, next); }
  }
}
