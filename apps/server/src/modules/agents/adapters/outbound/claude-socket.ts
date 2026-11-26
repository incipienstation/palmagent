import { claudeOutput } from "./claude-output.js";
import { buildClaudeUserMessage, claudeSkillPrompt, claudeAnswer } from "./claude-messages.js";
import { resolve } from "node:path";
import { expandHome } from "../../../../platform/filesystem/paths.js";
import type { AnswerRequest, AskQuestion, InputAttachment, PermissionRequest } from "@palmagent/shared";
import { normalizePermission } from "@palmagent/shared";
import type { AgentRunner, ProcHandle, ProcessBackend } from "../../application/ports/outbound/provider-process.js";
import type { Emit, RawEvent, StartArgs } from "../../domain/execution.js";
import type { RunHandle } from "../../domain/run-handle.js";

// Legacy runner sockets own the byte stream across server replacements. Keep their
// replay and request-ID protocol compatible until those installations drain and upgrade.
const IDLE_CLOSE_MS = 1500; // grace after `result` before we close stdin → process exits

// Strategy: map the task's per-agent permission to Claude's `--permission-mode`
// (values verbatim). Accepts the native modes AND the legacy shared enum
// (readonly|auto-edit|full) persisted before per-agent permissions; anything
// unknown falls back to the agent default. See PERMISSIONS in @palmagent/shared.
const permissionMode = (permission?: string) => normalizePermission("claude", permission);

type ClaudeLaunchArgs = Pick<StartArgs, "permission" | "model" | "effort" | "resumeId">;
export function buildClaudeArgv({ permission, model, effort, resumeId }: ClaudeLaunchArgs): string[] {
  const mode = permissionMode(permission);
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(mode === "bypassPermissions" ? ["--allow-dangerously-skip-permissions"] : []),
    "--permission-mode", mode,
    "--permission-prompt-tool", "stdio",
  ];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (resumeId) argv.push("--resume", resumeId);
  return argv;
}

export class ClaudeSocketRunner implements AgentRunner {
  readonly agent = "claude" as const;

  start(args: StartArgs, emit: Emit, backend: ProcessBackend): RunHandle {
    const { taskId, cwd, prompt, images, resumeId, permission, model, effort, reattach, resumeFromSeq, pendingInput, pendingApproval } = args;
    // `--permission-prompt-tool stdio` routes genuinely interactive requests to
    // the control channel; permission requests are surfaced through the same
    // approval lifecycle as questions. The launch matrix is centralized so
    // dispatch and resume cannot drift independently.
    const compacting = args.operation === "compact";
    if (compacting && !resumeId) throw new Error("An existing session is required to compact context.");
    const projectOutput = claudeOutput(args);
    const argv = buildClaudeArgv({ permission, model, effort, resumeId });
    if (args.interactive && !compacting) argv.push("--replay-user-messages");

    let sessionId: string | undefined = resumeId;

    // Reattach to a turn already running in the daemon (post-restart) vs. spawn a
    // fresh one. A failed reattach (turn no longer live) settles immediately.
    // CLAUDE_CONFIG_DIR isolates headless sessions from an interactively-used
    // ~/.claude directory on the same host.
    const providerHome = args.providerHome ?? (process.env.CLAUDE_CONFIG_DIR ? resolve(expandHome(process.env.CLAUDE_CONFIG_DIR)) : undefined);
    const env = providerHome ? { CLAUDE_CONFIG_DIR: providerHome } : undefined;
    const proc: ProcHandle | undefined = reattach
      ? backend.attach(taskId, 0)
      : backend.start({ turnId: taskId, command: "claude", argv, cwd, env });
    if (!proc) {
      emit({ taskId, kind: "status", sessionId, payload: { subtype: "reattach_failed" } });
      return { steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel: () => {}, done: Promise.resolve() };
    }

    let delivery: { id: string; text: string; images?: InputAttachment[]; sent: boolean;
      resolve: (s: "delivered" | "rejected" | "unknown") => void; timer: ReturnType<typeof setTimeout> } | undefined;
    const settleDelivery = (status: "delivered" | "rejected" | "unknown") => {
      if (!delivery) return;
      clearTimeout(delivery.timer); delivery.resolve(status); delivery = undefined; steerInFlight = false;
    };
    let steerInFlight = false;
    let steerTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let restoringClose = false;
    let intReq = 0;
    // Control requests are split into two user-controlled channels. The original
    // input is retained so an approval can echo it back to the CLI verbatim.
    const pendingQuestions = new Map<string, { questions: AskQuestion[] }>();
    const pendingApprovals = new Map<string, PermissionRequest>();
    if (reattach && pendingInput) {
      pendingQuestions.set(pendingInput.requestId, { questions: pendingInput.questions });
    }
    if (reattach && pendingApproval) pendingApprovals.set(pendingApproval.requestId, pendingApproval);

    const writeLine = (o: unknown) => {
      return proc.writeStdin(JSON.stringify(o) + "\n");
    };
    // Images ride the same stream-json channel as Anthropic-API image blocks
    // (verified: the CLI forwards them to the model — works mid-turn too).
    const sendUser = (text: string, imgs?: InputAttachment[], id?: string) => {
      writeLine({ ...buildClaudeUserMessage(text, imgs), ...(id ? { uuid: id } : {}) });
    };

    const scheduleClose = (restoring = false) => {
      if (closeTimer) clearTimeout(closeTimer);
      restoringClose = restoring;
      closeTimer = setTimeout(() => {
        if (!steerInFlight && proc.stdinWritable()) proc.closeStdin();
      }, IDLE_CLOSE_MS);
    };
    const cancelClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = undefined;
      restoringClose = false;
    };

    // One stdout NDJSON line. `seq` is the per-turn line number — every event we
    // emit from this line carries it so the service can drop already-persisted
    // events on reattach (exactly-once). Parsing rebuilds in-memory state (incl.
    // the idle-close decision) even for replayed lines.
    proc.onLine((seq, line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      const e = (raw: RawEvent) => emit(raw, seq);
      const replayed = reattach && seq <= (resumeFromSeq ?? 0);

      // Later activity supersedes a replayed result (for example a steered
      // turn). Do not cancel a live Stop's backstop while output is draining.
      if (restoringClose && ["stream_event", "assistant", "user", "control_request"].includes(ev.type)) cancelClose();

      // Claude emits synthetic user messages after compaction. Keep the summary
      // in the native session, outside the visible conversation and delivery queue.
      if (compacting && ev.type !== "system" && ev.type !== "result") return;

      projectOutput(ev, sessionId, e);
      switch (ev.type) {
        case "user": {
          if (typeof ev.uuid === "string" && (ev.uuid === args.messageId || ev.uuid === delivery?.id || args.interactive && ev.message?.role === "user" && ev.message?.content?.some((b: any) => b.type === "text"))) {
            e({ taskId, kind: "status", sessionId, payload: { subtype: "message_delivered", messageId: ev.uuid } });
            if (delivery?.id === ev.uuid) settleDelivery("delivered");
          }
          break;
        }
        case "result": {
          if (compacting) { proc.closeStdin(); break; }
          if (delivery && !delivery.sent) {
            delivery.sent = true;
            sendUser(delivery.text, delivery.images, delivery.id);
          }
          // Turn finished. Let the process go idle unless a steer is mid-injection.
          if (!steerInFlight) scheduleClose(!!replayed);
          break;
        }
        case "control_response":
          e({ taskId, kind: "status", sessionId, payload: { subtype: "control_response", response: ev.response } });
          break;
        // The CLI asks us to make a permission decision (--permission-prompt-tool
        // stdio). AskUserQuestion remains a structured input card; every other
        // permission request is surfaced as an approval card instead of being
        // silently denied.
        case "control_request": {
          if (replayed) break;
          const reqId: string = ev.request_id;
          const r = ev.request ?? {};
          if (r.subtype !== "can_use_tool") break;
          if (r.tool_name === "AskUserQuestion" && Array.isArray(r.input?.questions)) {
            const questions = r.input.questions as AskQuestion[];
            pendingQuestions.set(reqId, { questions });
            e({ taskId, kind: "question", sessionId, payload: { requestId: reqId, questions } });
          } else {
            const request: PermissionRequest = {
              requestId: reqId,
              tool: typeof r.tool_name === "string" ? r.tool_name : "Requested action",
              input: r.input,
              ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
            };
            pendingApprovals.set(reqId, request);
            e({ taskId, kind: "approval_request", sessionId, payload: request });
          }
          break;
        }
        default:
          break;
      }
    });

    proc.onStderr((text) => {
      emit({ taskId, kind: "status", sessionId, payload: { subtype: "stderr", text } });
    });

    const done = new Promise<void>((resolve) => {
      proc.onExit((code) => {
        cancelClose();
        settleDelivery("unknown");
        emit({ taskId, kind: "status", sessionId, payload: { subtype: "process_exit", code } });
        resolve();
      });
    });

    // Kick off the turn — unless reattaching, where the live turn already got it.
    if (!reattach) {
      if (compacting) sendUser("/compact");
      else sendUser(claudeSkillPrompt(prompt, args.skills), images, args.messageId);
    }

    return {
      send: (text, images, id, skills) => {
        if (compacting || !proc.stdinWritable() || delivery || closeTimer || !args.interactive) return Promise.resolve("rejected");
        steerInFlight = true; cancelClose();
        return new Promise(resolve => {
          const timer = setTimeout(() => { settleDelivery("unknown"); scheduleClose(); }, 15_000); timer.unref();
          delivery = { id, text: claudeSkillPrompt(text, skills), images, sent: false, resolve, timer };
          writeLine({ type: "control_request", request_id: `send_${id}`, request: { subtype: "interrupt" } });
        });
      },
      // True mid-turn steer: interrupt the active turn, then send the new instruction.
      steer: (text: string, imgs?: InputAttachment[]) => {
        if (compacting || !proc.stdinWritable()) return false;
        steerInFlight = true;
        cancelClose();
        writeLine({ type: "control_request", request_id: `int_${++intReq}`, request: { subtype: "interrupt" } });
        // Small gap so the interrupt lands before the new turn's message.
        steerTimer = setTimeout(() => {
          sendUser(text, imgs);
          steerInFlight = false;
        }, 250);
        return true;
      },
      // Graceful stop: interrupt the turn with NO follow-up message, so the CLI
      // emits its aborted result (subtype error_during_execution) and goes idle.
      // scheduleClose here is a backstop in case that result never lands; the
      // result handler re-schedules it anyway. A steer mid-injection is dropped
      // — stop wins over a not-yet-delivered steer message.
      interrupt: () => {
        if (!proc.stdinWritable()) return false;
        if (steerTimer) clearTimeout(steerTimer);
        settleDelivery(delivery?.sent ? "unknown" : "rejected");
        steerInFlight = false;
        writeLine({ type: "control_request", request_id: `int_${++intReq}`, request: { subtype: "interrupt" } });
        scheduleClose();
        return true;
      },
      // Resolve the oldest pending provider request. The service only clears its
      // durable pending state after this write is accepted by the child process.
      approve: (decision: string): boolean => {
        const pending = pendingApprovals.values().next().value as PermissionRequest | undefined;
        if (!pending || !proc.stdinWritable()) return false;
        const approved = decision === "approve";
        const written = writeLine({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: pending.requestId,
            response: approved
              ? { behavior: "allow", updatedInput: pending.input }
              : { behavior: "deny", message: "Denied by the user." },
          },
        });
        if (written) pendingApprovals.delete(pending.requestId);
        return written;
      },
      // Answer a pending AskUserQuestion: echo the original input back with the
      // user's picks as `answers` ({ [question]: label | label[] }), so the tool
      // produces a real result and the turn resumes. No picks anywhere → decline.
      answer: (req: AnswerRequest): boolean => {
        const pending = pendingQuestions.get(req.requestId);
        if (!pending || !proc.stdinWritable()) return false;
        if (!writeLine({ type: "control_response", response: {
          subtype: "success", request_id: req.requestId, response: claudeAnswer(pending.questions, req),
        } })) return false;
        pendingQuestions.delete(req.requestId);
        return true;
      },
      cancel: () => proc.kill("SIGINT"),
      done,
    };
  }
}
