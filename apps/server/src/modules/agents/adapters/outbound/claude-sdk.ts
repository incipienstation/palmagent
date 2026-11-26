import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { normalizePermission, type InputAttachment } from "@palmagent/shared";
import { expandHome } from "../../../../platform/filesystem/paths.js";
import type { AgentRunner } from "../../application/ports/outbound/provider-process.js";
import type { RunHandle } from "../../domain/run-handle.js";
import { buildClaudeUserMessage, claudeSkillPrompt } from "./claude-messages.js";
import { ClaudeSdkPermissions } from "./claude-sdk-permissions.js";
import { claudeOutput } from "./claude-output.js";
import { findAgentExecutable } from "./agent-installations.js";

type Receipt = "delivered" | "rejected" | "unknown";

export const claudeSdkRunner: AgentRunner = {
  agent: "claude",
  start(args, emit): RunHandle {
    const { taskId } = args;
    const compacting = args.operation === "compact";
    if (compacting && !args.resumeId) throw new Error("An existing session is required to compact context.");
    if (args.reattach) {
      // The retained host owns its query. ExecutionBackend reconnects to its journal.
      emit({ taskId, sessionId: args.resumeId, kind: "status", payload: { subtype: "reattach_failed" } });
      return { done: Promise.resolve(), cancel() {}, interrupt: () => false, answer: () => false,
        approve: () => false, steer: () => false };
    }

    let sessionId = args.resumeId;
    const abort = new AbortController();
    const input = new PassThrough({ objectMode: true });
    const project = claudeOutput(args);
    const permissions = new ClaudeSdkPermissions(event => emit({ ...event, taskId, sessionId }));

    const mode = normalizePermission("claude", args.permission);
    const providerHome = args.providerHome ?? (process.env.CLAUDE_CONFIG_DIR && resolve(expandHome(process.env.CLAUDE_CONFIG_DIR)));
    const ready = import("@anthropic-ai/claude-agent-sdk/core").then(({ query }) => {
      abort.signal.throwIfAborted();
      const executable = findAgentExecutable("claude");
      if (!executable) throw new Error("Claude Code executable is unavailable.");
      return query({
        prompt: input as AsyncIterable<SDKUserMessage>,
        options: {
          pathToClaudeCodeExecutable: executable, cwd: args.cwd, model: args.model, resume: sessionId,
          ...(providerHome ? { env: { ...process.env, CLAUDE_CONFIG_DIR: providerHome } } : {}),
          abortController: abort, canUseTool: permissions.request, includePartialMessages: true,
          systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["user", "project", "local"],
          // Forward the installed CLI's permission vocabulary (including manual) verbatim.
          extraArgs: { "permission-mode": mode, ...(args.effort ? { effort: args.effort } : {}),
            ...(args.interactive && !compacting ? { "replay-user-messages": null } : {}) },
          allowDangerouslySkipPermissions: mode === "bypassPermissions",
          stderr: text => emit({ taskId, sessionId, kind: "status", payload: { subtype: "stderr", text } }),
        },
      });
    });

    const awaitingEcho = new Set<string>();
    function sendUser(text: string, images?: InputAttachment[], uuid?: string) {
      const message = buildClaudeUserMessage(text, images);
      if (uuid) awaitingEcho.add(uuid);
      input.write({ ...message, parent_tool_use_id: null, ...(uuid ? { uuid } : {}) });
    }
    sendUser(compacting ? "/compact" : claudeSkillPrompt(args.prompt, args.skills), args.images, args.messageId);

    let idle = false;
    let closed = false;
    let stopping = false;
    let closeTimer: NodeJS.Timeout | undefined;
    let delivery: { id: string; text: string; images?: InputAttachment[]; interrupted: boolean; sent: boolean;
      timer: NodeJS.Timeout; resolve: (receipt: Receipt) => void } | undefined;
    function settle(receipt: Receipt) {
      if (!delivery) return;
      clearTimeout(delivery.timer);
      delivery.resolve(receipt);
      delivery = undefined;
    }
    function closeAfterResult() {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => input.end(), 1500);
      closeTimer.unref();
    }
    // Either the interrupted turn's result or the SDK interrupt receipt can arrive
    // first. Deliver the new prompt once, after both, and acknowledge only its UUID echo.
    function dispatchFollowup() {
      if (!idle || !delivery?.interrupted || delivery.sent || stopping || closed) return;
      delivery.sent = true;
      idle = false;
      sendUser(delivery.text, delivery.images, delivery.id);
    }
    function replaceTurn(text: string, images: InputAttachment[] | undefined, id: string, resolve: (r: Receipt) => void) {
      if (compacting || stopping || closed || input.writableEnded || delivery) return false;
      clearTimeout(closeTimer);
      const timer = setTimeout(() => { settle("unknown"); if (idle) closeAfterResult(); }, 15_000);
      timer.unref();
      const request = { id, text, images, sent: false, interrupted: idle, timer, resolve };
      delivery = request;
      if (idle) dispatchFollowup();
      else void ready.then(query => query.interrupt()).then(() => {
        if (delivery !== request) return;
        request.interrupted = true;
        dispatchFollowup();
      }, () => { if (delivery === request) { settle("unknown"); if (idle) closeAfterResult(); } });
      return true;
    }
    const done = (async () => {
      let code = 0;
      let conversation: Awaited<typeof ready> | undefined;
      try {
        conversation = await ready;
        for await (const message of conversation) {
          if (message.session_id) sessionId = message.session_id;
          if (!compacting && message.type === "user" && message.uuid && awaitingEcho.delete(message.uuid)) {
            emit({ taskId, sessionId, kind: "status", payload: { subtype: "message_delivered", messageId: message.uuid } });
            if (message.uuid === delivery?.id) settle("delivered");
          }
          project(message, sessionId, emit);
          if (message.type === "result") {
            idle = true;
            if (compacting) input.end();
            else if (delivery && !delivery.sent) dispatchFollowup();
            else closeAfterResult();
          }
        }
      } catch (error) {
        code = 1;
        if (!abort.signal.aborted) emit({ taskId, sessionId, kind: "error", payload: { message: String(error) } });
      } finally {
        closed = true;
        clearTimeout(closeTimer);
        settle("unknown");
        permissions.close();
        input.end();
        conversation?.close();
        emit({ taskId, sessionId, kind: "status", payload: { subtype: "process_exit", code } });
      }
    })();

    return {
      done,
      send: (text, images, id, skills) => new Promise(resolve => {
        if (!args.interactive || idle || !replaceTurn(claudeSkillPrompt(text, skills), images, id, resolve)) resolve("rejected");
      }),
      steer: (text, images) => replaceTurn(text, images, randomUUID(), () => {}),
      interrupt() {
        if (closed || stopping) return false;
        stopping = true;
        settle(delivery?.sent ? "unknown" : "rejected");
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => abort.abort(), 2000);
        closeTimer.unref();
        void ready.then(query => query.interrupt()).catch(() => abort.abort());
        return true;
      },
      approve: decision => permissions.approve(decision),
      answer: answer => permissions.answer(answer),
      cancel() {
        stopping = true;
        settle(delivery?.sent ? "unknown" : "rejected");
        abort.abort();
      },
    };
  },
};
