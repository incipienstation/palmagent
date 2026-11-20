import { isClosedTaskStatus, type InputAttachment, type SkillSelection, type TaskState, type TaskStatus } from "@palmagent/shared";
import type { RawEvent, RunHandle, RunnerBackend } from "../../../agents/api.js";
import { observeTurn, type TurnEvidence } from "../../domain/turn-policy.js";
import type { TaskRepository } from "../ports/outbound/persistence.js";
import type { TaskSupervisor } from "../ports/outbound/task-runtime.js";
import type { MessageController } from "./message-controller.js";

import type { RetainedTurns, TurnTicket, TurnObservation } from "../ports/outbound/retained-turns.js";

function observation(event: RawEvent): TurnObservation {
  if (event.kind === "error") {
    const message = (event.payload as { message?: unknown } | null)?.message;
    return { kind: "error", message: typeof message === "string" ? message : undefined };
  }
  if (event.kind === "result") return { kind: "result", failed: !!(event.payload as { is_error?: boolean } | null)?.is_error };
  if (event.kind === "status") {
    const status = event.payload as { subtype?: string; code?: number } | null;
    if (status?.subtype === "process_exit") return { kind: "processExit", success: status.code === 0 };
    if (status?.subtype === "reattach_failed") return { kind: "reattachFailed" };
  }
  return { kind: "output" };
}

interface TaskExecutionEffects {
  restarting?(taskId: string): boolean;
  startRetained?(task: TaskState, runId: string): void;
  transition(task: TaskState, status: TaskStatus, opts?: { interrupted?: boolean }): void;
  resolveSkills(taskId: string, skills: SkillSelection[]): Promise<SkillSelection[] | undefined>;
  error(task: TaskState, message: string): void;
  sessionMismatch(taskId: string): void;
  event(task: TaskState, event: RawEvent, rawSeq: number | undefined, replayed: boolean): void;
  finished(task: TaskState, evidence: TurnEvidence): void;
}

interface ActiveTurn {
  task: TaskState;
  runId: string | null;
  baseline: number;
  evidence: TurnEvidence;
  sessionMismatch: boolean;
  reserved: boolean;
  handle?: RunHandle;
  ticket?: TurnTicket;
}

/** Owns admission, handles and replay for one service lifetime. Task effects stay in TaskService. */
export class TaskExecution {
  private closed = false;
  private turns = new Map<string, ActiveTurn>();
  constructor(private readonly db: Pick<TaskRepository, "getTaskRawSeq" | "setTaskRawSeq">,
    private readonly supervisor: TaskSupervisor, private readonly backend: RunnerBackend,
    private readonly messages: MessageController, private readonly effects: TaskExecutionEffects, private readonly native?: RetainedTurns) {}

  close(): void {
    this.closed = true;
    this.turns.clear();
    // View shutdown must not settle a retained execution or consume its replay.
  }

  async run(task: TaskState, prompt: string, resumeId?: string, images?: InputAttachment[], messageId?: string,
    skills?: SkillSelection[], compactionRequestId?: string): Promise<void> {
    if (this.closed) return;
    const runId = this.messages.beginRun(task.taskId, messageId, compactionRequestId, this.backend.independent);
    const turn = this.track(task, runId, 0);
    if (!this.backend.independent) {
      if (!this.supervisor.tryAcquire()) {
        this.effects.transition(task, "queued");
        await this.supervisor.acquire();
        turn.reserved = true;
        if (!this.canStart(turn) || task.status !== "queued") { this.abandon(turn); return; }
      } else turn.reserved = true;
    }
    if (skills?.length) {
      this.effects.transition(task, "queued");
      try { skills = await this.effects.resolveSkills(task.taskId, skills); }
      catch (error) {
        const current = this.canStart(turn) && task.status === "queued";
        this.abandon(turn);
        if (!current) return;
        const message = error instanceof Error ? error.message : "Skill is unavailable.";
        this.effects.error(task, message);
        this.effects.transition(task, "failed");
        this.messages.rejectBeforeStart(task.taskId, message);
        return;
      }
      if (!this.canStart(turn) || isClosedTaskStatus(task.status)) { this.abandon(turn); return; }
    }
    if (!this.canStart(turn)) { this.abandon(turn); return; }
    if (this.effects.startRetained) {
      this.effects.startRetained(task, runId);
    } else {
      this.db.setTaskRawSeq(task.taskId, 0);
      this.effects.transition(task, "running", { interrupted: false });
      this.messages.startingRuntime(task.taskId);
    }
    let handle: RunHandle;
    try {
      handle = this.backend.agentRunner(task.agent).start({
        taskId: task.taskId, executionId: this.backend.independent ? runId : undefined, messageId, interactive: true,
        operation: this.messages.state(task.taskId).compaction?.status === "running" ? "compact" : undefined,
        cwd: task.worktreePath!, prompt, skills, images, resumeId,
        providerHome: task.sessionControl?.home, permission: task.permission, model: task.model, effort: task.effort,
      }, (event, rawSeq) => this.onEvent(turn, event, rawSeq));
    } catch (error) {
      this.abandon(turn);
      this.effects.error(task, `failed to start turn: ${String(error)}`);
      this.effects.transition(task, "failed");
      this.messages.finish(task.taskId, true, false, "Context compaction could not start. Try again.");
      return;
    }
    turn.handle = handle;
    this.supervisor.register(task.taskId, handle);
    turn.reserved = false; // The registered handle now owns the acquired slot.
    this.onDone(turn, handle);
  }

  reattach(task: TaskState): void {
    if (this.closed) return;
    const state = this.messages.state(task.taskId);
    const turn = this.track(task, state.runId, this.db.getTaskRawSeq(task.taskId));
    let handle: RunHandle;
    try {
      handle = this.backend.agentRunner(task.agent).start({
        taskId: task.taskId, executionId: state.executionId === state.runId ? state.executionId : undefined, cwd: task.worktreePath!, messageId: state.initialMessageId,
        interactive: state.protocol === "interactive",
        operation: state.compaction?.status === "running" ? "compact" : undefined,
        prompt: "", resumeId: task.sessionId, permission: task.permission, model: task.model, effort: task.effort,
        reattach: true, resumeFromSeq: turn.baseline,
        pendingInput: task.pendingInput, pendingApproval: task.pendingApproval,
      }, (event, rawSeq) => this.onEvent(turn, event, rawSeq));
    } catch (error) { this.abandon(turn); throw error; }
    turn.handle = handle;
    this.supervisor.reclaim(task.taskId, handle);
    this.onDone(turn, handle);
  }

  private track(task: TaskState, runId: string | null, baseline: number): ActiveTurn {
    const turn = { task, runId, baseline, ticket: this.native?.track(task.taskId, runId, baseline), reserved: false, sessionMismatch: false,
      evidence: { sawResult: false, lastResultError: false, errored: false } };
    this.turns.set(task.taskId, turn);
    return turn;
  }
  private current(turn: ActiveTurn): boolean { return !this.closed && this.turns.get(turn.task.taskId) === turn; }
  private canStart(turn: ActiveTurn): boolean {
    return this.current(turn) && this.messages.state(turn.task.taskId).runId === turn.runId;
  }
  private abandon(turn: ActiveTurn): void {
    // A cancelled reservation may outlive a newer turn for the same task.
    // Release only its capacity; never delete that newer turn's handle.
    if (turn.reserved) { turn.reserved = false; this.supervisor.releaseSlot(); }
    if (!this.closed && turn.ticket) this.native!.end(turn.ticket);
    if (this.turns.get(turn.task.taskId) === turn) this.turns.delete(turn.task.taskId);
  }
  private onEvent(turn: ActiveTurn, event: RawEvent, rawSeq?: number): void {
    if (!this.current(turn) || turn.sessionMismatch) return;
    const task = turn.task;
    const disposition = turn.ticket && this.native!.observe(turn.ticket, observation(event), task.sessionId, event.sessionId, rawSeq);
    if (disposition === "ignore") return;
    const mismatch = disposition ? disposition === "stopForSessionMismatch" : task.sessionId && event.sessionId && task.sessionId !== event.sessionId;
    if (mismatch) {
      turn.sessionMismatch = true;
      turn.evidence.errored = true; turn.evidence.abnormalExit = true;
      this.effects.sessionMismatch(task.taskId);
      event = { taskId: task.taskId, sessionId: task.sessionId, kind: "error", payload: {
        message: "The CLI returned a different session identity. The turn was stopped; the original session is retained.",
      } };
      queueMicrotask(() => { if (this.current(turn)) turn.handle?.cancel(); });
    }
    if (!disposition || mismatch) observeTurn(turn.evidence, event);
    const replayed = disposition && !mismatch ? disposition === "replay" : rawSeq !== undefined && rawSeq <= turn.baseline;
    this.effects.event(task, event, rawSeq, replayed);
  }
  private onDone(turn: ActiveTurn, handle: RunHandle): void {
    const finish = () => {
      if (!this.current(turn) || this.supervisor.get(turn.task.taskId) !== handle) return;
      this.turns.delete(turn.task.taskId);
      this.supervisor.release(turn.task.taskId);
      this.backend.release?.(turn.task.taskId);
      const evidence = turn.ticket ? this.native!.end(turn.ticket, this.messages.state(turn.task.taskId).compaction?.status === "running", this.effects.restarting?.(turn.task.taskId)) : turn.evidence;
      if (!evidence) return;
      if (turn.sessionMismatch) evidence.failureMessage = turn.evidence.failureMessage;
      this.effects.finished(turn.task, evidence);
    };
    void handle.done.then(finish, finish);
  }
}
