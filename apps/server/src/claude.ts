import type { AnswerRequest, AskQuestion, ImageAttachment } from "@palmagent/shared";
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
  acceptEdits: "acceptEdits",
  dontAsk: "dontAsk",
  bypassPermissions: "bypassPermissions",
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
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", permissionMode(permission),
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
    const { taskId, cwd, prompt, images, resumeId, permission, model, effort, reattach, resumeFromSeq, pendingInput } = args;
    // `--permission-prompt-tool stdio` routes genuinely interactive requests to
    // the control channel; non-question requests are denied below. The launch
    // matrix is centralized so dispatch and resume cannot drift independently.
    const argv = buildClaudeArgv({ permission, model, effort, resumeId });

    let sessionId: string | undefined = resumeId;

    // Reattach to a turn already running in the daemon (post-restart) vs. spawn a
    // fresh one. A failed reattach (turn no longer live) settles immediately.
    // CLAUDE_CONFIG_DIR isolates headless sessions from an interactively-used
    // ~/.claude directory on the same host.
    const env = config.claudeConfigDir ? { CLAUDE_CONFIG_DIR: config.claudeConfigDir } : undefined;
    const proc: ProcHandle | undefined = reattach
      ? backend.attach(taskId, resumeFromSeq ?? 0)
      : backend.start({ turnId: taskId, command: "claude", argv, cwd, env });
    if (!proc) {
      emit({ taskId, kind: "status", sessionId, payload: { subtype: "reattach_failed" } });
      return { steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel: () => {}, done: Promise.resolve() };
    }

    let steerInFlight = false;
    let steerTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let intReq = 0;
    // AskUserQuestion: control_request id → the CLI's original tool input, kept so
    // answer() can echo it back with the user's picks. On reattach the daemon does
    // NOT replay the original can_use_tool line (its seq is at/below the persisted
    // high-water-mark), so re-seed the map from the task's persisted pendingInput —
    // otherwise answering a paused-on-question turn fails ("no matching pending
    // question to answer") after a web-server restart. The CLI child is the same one
    // still blocked on this request_id, so writing its control_response unblocks it.
    const pendingQuestions = new Map<string, { questions: AskQuestion[] }>();
    if (reattach && pendingInput) {
      pendingQuestions.set(pendingInput.requestId, { questions: pendingInput.questions });
    }

    const writeLine = (o: unknown) => {
      proc.writeStdin(JSON.stringify(o) + "\n");
    };
    // Images ride the same stream-json channel as Anthropic-API image blocks
    // (verified: the CLI forwards them to the model — works mid-turn too).
    const sendUser = (text: string, imgs?: ImageAttachment[]) => {
      writeLine(buildClaudeUserMessage(text, imgs));
    };

    const scheduleClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!steerInFlight && proc.stdinWritable()) proc.closeStdin();
      }, IDLE_CLOSE_MS);
    };
    const cancelClose = () => {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = undefined;
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
          if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
            e({ taskId, kind: "assistant_text", sessionId, payload: { text: inner.delta.text } });
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
          // Turn finished. Let the process go idle unless a steer is mid-injection.
          if (!steerInFlight) scheduleClose();
          break;
        case "control_response":
          e({ taskId, kind: "status", sessionId, payload: { subtype: "control_response", response: ev.response } });
          break;
        // The CLI asks US to make a permission decision (--permission-prompt-tool
        // stdio). Under acceptEdits this fires ONLY for genuinely-interactive
        // tools; AskUserQuestion is the one we surface. Anything else is
        // auto-denied to preserve the prior (no-flag) non-interactive behavior.
        case "control_request": {
          const reqId: string = ev.request_id;
          const r = ev.request ?? {};
          if (r.subtype !== "can_use_tool") break;
          if (r.tool_name === "AskUserQuestion" && Array.isArray(r.input?.questions)) {
            const questions = r.input.questions as AskQuestion[];
            pendingQuestions.set(reqId, { questions });
            e({ taskId, kind: "question", sessionId, payload: { requestId: reqId, questions } });
          } else {
            writeLine({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: reqId,
                response: { behavior: "deny", message: "Auto-denied (non-interactive dispatch)." },
              },
            });
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
        emit({ taskId, kind: "status", sessionId, payload: { subtype: "process_exit", code } });
        resolve();
      });
    });

    // Kick off the turn — unless reattaching, where the live turn already got it.
    if (!reattach) sendUser(prompt, images);

    return {
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
        steerInFlight = false;
        writeLine({ type: "control_request", request_id: `int_${++intReq}`, request: { subtype: "interrupt" } });
        scheduleClose();
        return true;
      },
      // Under --permission-mode acceptEdits the CLI auto-accepts edits, so there
      // is no live approval channel to answer. The service records the decision.
      approve: () => false,
      // Answer a pending AskUserQuestion: echo the original input back with the
      // user's picks as `answers` ({ [question]: label | label[] }), so the tool
      // produces a real result and the turn resumes. No picks anywhere → decline.
      answer: (req: AnswerRequest): boolean => {
        const pending = pendingQuestions.get(req.requestId);
        if (!pending || !proc.stdinWritable()) return false;
        pendingQuestions.delete(req.requestId);
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
          writeLine({
            type: "control_response",
            response: { subtype: "success", request_id: req.requestId, response: { behavior: "deny", message: "User declined to answer." } },
          });
          return true;
        }
        const updatedInput: Record<string, unknown> = { questions: pending.questions, answers };
        if (Object.keys(annotations).length) updatedInput.annotations = annotations;
        if (response) updatedInput.response = response;
        writeLine({
          type: "control_response",
          response: { subtype: "success", request_id: req.requestId, response: { behavior: "allow", updatedInput } },
        });
        return true;
      },
      cancel: () => proc.kill("SIGINT"),
      done,
    };
  }
}
