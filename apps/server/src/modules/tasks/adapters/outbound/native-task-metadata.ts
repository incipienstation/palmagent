import type { PermissionRequest, PrRef, QuestionRequest, TaskState, TaskStatus } from "@palmagent/shared";
import type { TaskMetadata } from "../../application/ports/outbound/retained-turns.js";

type Change = { kind: string; taskId: string } & Record<string, unknown>;

/** Collect related metadata updates, then send them to one native transaction.
 * TaskService publishes the new cache state after this call returns. */
export class NativeTaskMetadata implements TaskMetadata {
  private pending?: Change[];
  constructor(private readonly commit: (changes: Change[]) => number | null) {}

  transaction(work: () => void): void {
    const outer = this.pending;
    this.pending = [];
    try {
      work();
      if (outer) outer.push(...this.pending);
      else if (this.pending.length) this.commit(this.pending);
    } finally { this.pending = outer; }
  }

  private write(change: Change): void {
    if (this.pending) this.pending.push(change);
    else this.commit([change]);
  }
  setTaskPin(taskId: string, pinned: boolean, now: number) {
    if (this.pending) throw new Error("Pin allocation requires a committed result");
    return this.commit([{ kind: "pin", taskId, pinned, now }]) ?? undefined;
  }
  setTaskPinOrder(pins: { taskId: string; pinnedAt: number }[], now: number) {
    this.transaction(() => { for (const pin of pins) this.write({ kind: "movePin", ...pin, now }); });
  }
  setTaskTitle(taskId: string, title: string, now: number) { this.write({ kind: "rename", taskId, title, now }); }
  setTaskStatus(taskId: string, status: TaskStatus, interrupted: boolean, now: number) {
    this.write({ kind: "status", taskId, status, interrupted, now });
  }
  setTaskSession(taskId: string, sessionId: string, now: number) { this.write({ kind: "session", taskId, sessionId, now }); }
  setSessionControl(taskId: string, control: TaskState["sessionControl"]) {
    this.write({ kind: "control", taskId, body: JSON.stringify(control) });
  }
  setTaskSettings(taskId: string, model: string | undefined, effort: string | undefined, permission: string, now: number) {
    this.write({ kind: "settings", taskId, model, effort, permission, now });
  }
  setTaskPrs(taskId: string, prs: PrRef[], now: number) {
    this.write({ kind: "pullRequests", taskId, body: JSON.stringify(prs), first: prs[0]?.url, now });
  }
  setTaskPendingInput(taskId: string, input: QuestionRequest | undefined, now: number) {
    this.write({ kind: "pendingInput", taskId, body: JSON.stringify(input), now });
  }
  setTaskPendingApproval(taskId: string, approval: PermissionRequest | undefined, now: number) {
    this.write({ kind: "pendingApproval", taskId, body: JSON.stringify(approval), now });
  }
  insertApproval(taskId: string, eventId: number | null, body: string | null, decision: string, now: number) {
    this.write({ kind: "approval", taskId, eventId, body, decision, now });
  }
}
