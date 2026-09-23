import type { AnswerRequest, AskQuestion, ImageAttachment, PermissionRequest } from "@palmagent/shared";
import { DEFAULT_PERMISSION } from "@palmagent/shared";
import { config } from "./config.js";
import type { AgentRunner, Emit, ProcHandle, RawEvent, RunHandle, RunnerBackend, StartArgs } from "./types.js";

// Claude's launch and stream protocol live here as executable integration code.
// Keep the argument matrix and normalized-event behavior covered by the adapter
// contract tests instead of duplicating them in a version-specific document.
// Prompt is delivered as a stream-json user message on stdin (not the -p arg) so
// the same channel can carry mid-turn steers. The process + stdio are owned by
// the RunnerBackend (a separate daemon in production), so all of the below — argv,
// the stdin steer/interrupt protocol, NDJSON parsing, and idle-stdin-close — lives
// here in the web server and can be updated independently of the runner daemon.

const IDLE_CLOSE_MS = 1500; // grace after `result` before we close stdin → process exits

// Strategy: map the task's per-agent permission to Claude's `--permission-mode`
// (values verbatim). Accepts the native modes AND the legacy shared enum
// (readonly|auto-edit|full) persisted before per-agent permissions; anything
// unknown falls back to the agent default. See PERMISSIONS in @palmagent/shared.
const PERMISSION_MODE: Record<string, string> = {
  plan: "plan",
  auto: "auto",
  acceptEdits: "acceptEdits",
  manual: "manual",
  dontAsk: "dontAsk",
  bypassPermissions: "bypassPermissions",
  // Older settings called the provider default "default".
  default: "auto",
  // legacy shared-enum values (pre per-agent permissions)
  readonly: "plan",
  "auto-edit": "acceptEdits",
  full: "bypassPermissions",
};
const permissionMode = (p?: string): string => PERMISSION_MODE[p ?? ""] ?? PERMISSION_MODE[DEFAULT_PERMISSION.claude];

type ClaudeLaunchArgs = Pick<StartArgs, "permission" | "model" | "effort" | "resumeId">;
type ClaudeUserMessage = {
  type: "user";
  message: {
    role: "user";
    content: Array<
      | { type: "image"; source: { type: "base64"; media_type: ImageAttachment["mediaType"]; data: string } }
      | { type: "text"; text: string }
    >;
  };
};

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

export function buildClaudeUserMessage(text: string, images: readonly ImageAttachment[] = []): ClaudeUserMessage {
  const content: ClaudeUserMessage["message"]["content"] = images.map((image) => ({
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  }));
  content.push({ type: "text", text });
  return { type: "user", message: { role: "user", content } };
}

export class ClaudeRunner implements AgentRunner {
  readonly agent = "claude" as const;

  start(args: StartArgs, emit: Emit, backend: RunnerBackend): RunHandle {
    const { taskId, cwd, prompt, images, resumeId, permission, model, effort, reattach, resumeFromSeq, pendingInput, pendingApproval } = args;
    // `--permission-prompt-tool stdio` routes genuinely interactive requests to
    // the control channel; permission requests are surfaced through the same
    // approval lifecycle as questions. The launch matrix is centralized so
    // dispatch and resume cannot drift independently.
    const argv = buildClaudeArgv({ permission, model, effort, resumeId });
    if (args.interactive) argv.push("--replay-user-messages");

    let sessionId: string | undefined = resumeId;

    // Reattach to a turn already running in the daemon (post-restart) vs. spawn a
    // fresh one. A failed reattach (turn no longer live) settles immediately.
    // CLAUDE_CONFIG_DIR isolates headless sessions from an interactively-used
    // ~/.claude directory on the same host.
    const providerHome = args.providerHome ?? config.claudeConfigDir;
    const env = providerHome ? { CLAUDE_CONFIG_DIR: providerHome } : undefined;
    const proc: ProcHandle | undefined = reattach
      ? backend.attach(taskId, 0)
      : backend.start({ turnId: taskId, command: "claude", argv, cwd, env });
    if (!proc) {
      emit({ taskId, kind: "status", sessionId, payload: { subtype: "reattach_failed" } });
      return { steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel: () => {}, done: Promise.resolve() };
    }

    let delivery: { id: string; text: string; images?: ImageAttachment[]; sent: boolean;
      resolve: (s: "delivered" | "rejected" | "unknown") => void; timer: ReturnType<typeof setTimeout> } | undefined;
    const settleDelivery = (status: "delivered" | "rejected" | "unknown") => {
      if (!delivery) return;
      clearTimeout(delivery.timer); delivery.resolve(status); delivery = undefined; steerInFlight = false;
    };
    let messageId: string | undefined;
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
    const sendUser = (text: string, imgs?: ImageAttachment[], id?: string) => {
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

      switch (ev.type) {
        case "system":
          e({ taskId, kind: "status", sessionId,
            payload: { subtype: ev.subtype, model: ev.model, cwd: ev.cwd, tools: ev.tools?.length } });
          break;
        case "rate_limit_event":
          e({ taskId, kind: "status", sessionId, payload: { subtype: "rate_limit", info: ev } });
          break;
        case "stream_event": {
          const inner = ev.event;
          if (inner?.type === "message_start") messageId = inner.message?.id;
          if (inner?.type === "message_delta" && messageId) {
            const reason = inner.delta?.stop_reason;
            const phase = reason === "tool_use" ? "progress" : reason === "end_turn" ? "final" : undefined;
            if (phase) e({ taskId, kind: "status", sessionId,
              payload: { subtype: "assistant_message", messageId, phase } });
          }
          if (inner?.type === "message_stop") messageId = undefined;
          if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            e({ taskId, kind: "assistant_text", sessionId, payload: { text: inner.delta.text, ...(messageId ? { messageId } : {}) } });
          }
          break;
        }
        case "assistant": {
          // Text already streamed via deltas; surface tool_use blocks as tool calls.
          for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_use") {
              e({ taskId, kind: "tool_call", sessionId,
                payload: { id: block.id, name: block.name, input: block.input } });
            }
          }
          break;
        }
        case "user": {
          if (typeof ev.uuid === "string" && (ev.uuid === args.messageId || ev.uuid === delivery?.id || args.interactive && ev.message?.role === "user" && ev.message?.content?.some((b: any) => b.type === "text"))) {
            e({ taskId, kind: "status", sessionId, payload: { subtype: "message_delivered", messageId: ev.uuid } });
            if (delivery?.id === ev.uuid) settleDelivery("delivered");
          }
          // tool results fed back into the conversation
          for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_result") {
              e({ taskId, kind: "tool_result", sessionId,
                payload: { tool_use_id: block.tool_use_id, content: block.content, is_error: block.is_error } });
            }
          }
          break;
        }
        case "result":
          e({ taskId, kind: "result", sessionId,
            payload: { subtype: ev.subtype, is_error: ev.is_error, result: ev.result,
              num_turns: ev.num_turns, duration_ms: ev.duration_ms, total_cost_usd: ev.total_cost_usd } });
          if (delivery && !delivery.sent) {
            delivery.sent = true;
            sendUser(delivery.text, delivery.images, delivery.id);
          }
          // Turn finished. Let the process go idle unless a steer is mid-injection.
          if (!steerInFlight) scheduleClose(!!replayed);
          break;
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
    if (!reattach) sendUser(claudeSkillPrompt(prompt, args.skills), images, args.messageId);

    return {
      send: (text, images, id, skills) => {
        if (!proc.stdinWritable() || delivery || closeTimer || !args.interactive) return Promise.resolve("rejected");
        steerInFlight = true; cancelClose();
        return new Promise(resolve => {
          const timer = setTimeout(() => { settleDelivery("unknown"); scheduleClose(); }, 15_000); timer.unref();
          delivery = { id, text: claudeSkillPrompt(text, skills), images, sent: false, resolve, timer };
          writeLine({ type: "control_request", request_id: `send_${id}`, request: { subtype: "interrupt" } });
        });
      },
      // True mid-turn steer: interrupt the active turn, then send the new instruction.
      steer: (text: string, imgs?: ImageAttachment[]) => {
        if (!proc.stdinWritable()) return false;
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
        const byQuestion = new Map(pending.questions.map((q) => [q.question, q]));
        const answers: Record<string, string | string[]> = {};
        const annotations: Record<string, { notes: string }> = {};
        for (const a of req.answers ?? []) {
          if (a.selected?.length) {
            answers[a.question] = byQuestion.get(a.question)?.multiSelect ? a.selected : a.selected[0];
          }
          if (a.notes?.trim()) annotations[a.question] = { notes: a.notes.trim() };
        }
        const response = req.response?.trim();
        const picked = Object.keys(answers).length > 0 || Object.keys(annotations).length > 0 || !!response;
        if (!picked) {
          if (!writeLine({
            type: "control_response",
            response: { subtype: "success", request_id: req.requestId, response: { behavior: "deny", message: "User declined to answer." } },
          })) return false;
          pendingQuestions.delete(req.requestId);
          return true;
        }
        const updatedInput: Record<string, unknown> = { questions: pending.questions, answers };
        if (Object.keys(annotations).length) updatedInput.annotations = annotations;
        if (response) updatedInput.response = response;
        if (!writeLine({
          type: "control_response",
          response: { subtype: "success", request_id: req.requestId, response: { behavior: "allow", updatedInput } },
        })) return false;
        pendingQuestions.delete(req.requestId);
        return true;
      },
      cancel: () => proc.kill("SIGINT"),
      done,
    };
  }
}

export function claudeSkillPrompt(text: string, skills?: StartArgs["skills"]): string {
  return skills?.length ? `/${skills[0].name} ${text}` : text;
}
