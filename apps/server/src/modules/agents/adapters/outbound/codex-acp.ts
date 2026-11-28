import { pathToFileURL } from "node:url";
import { client, type ContentBlock, type NewSessionResponse, type ResumeSessionResponse, type SessionUpdate } from "@agentclientprotocol/sdk";
import { codexSandbox, sampledAgentInput, TURN_RESULT_MISSING, type InputAttachment, type SkillSelection } from "@palmagent/shared";
import { z } from "zod";
import type { AgentRunner } from "../../application/ports/outbound/provider-process.js";
import type { Emit, StartArgs } from "../../domain/execution.js";
import type { RunHandle } from "../../domain/run-handle.js";
import { startAcpProcess, type AcpBridge } from "./acp-process.js";
import { codexHookStop } from "./codex-hooks.js";
import { CodexAcpQuestions } from "./codex-acp-questions.js";

function prompt(text: string, images?: InputAttachment[], skills?: SkillSelection[]): ContentBlock[] {
  const input = sampledAgentInput(text, images);
  return [
    { type: "text", text: [...(skills ?? []).map(skill => "$" + skill.name), input.text].join("\n") },
    ...(skills ?? []).filter((s): s is SkillSelection & { path: string } => !!s.path).map(({ name, path }) => ({ type: "resource_link" as const, name, uri: pathToFileURL(path).href,
      _meta: { palmagentSkill: { name, path } } })),
    ...input.images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })),
  ];
}

const lifecycle = z.discriminatedUnion("method", [
  z.object({ method: z.literal("turn/started"), turnId: z.string() }),
  z.object({ method: z.literal("hook/completed"), turnId: z.string(), run: z.looseObject({ id: z.string(), status: z.literal("stopped") }) }),
  z.object({ method: z.literal("thread/tokenUsage/updated"), tokenUsage: z.looseObject({ last: z.object({
    inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }) }) }),
  z.object({ method: z.enum(["item/started", "item/completed"]), messageId: z.string(), phase: z.string().nullish() }),
]);
type Receipt = "delivered" | "rejected" | "unknown";

export function codexAcpRunner(bridge: AcpBridge, executable: string): AgentRunner {
  return { agent: "codex", start: (args, emit) => start(bridge, executable, args, emit) };
}

function start(bridge: AcpBridge, executable: string, args: StartArgs, emit: Emit): RunHandle {
  const sandbox = codexSandbox(args.permission).mode;
  const mode = sandbox === "danger-full-access" ? "agent-full-access" : sandbox;
  const peer = startAcpProcess(bridge, args.cwd, { ...process.env, PALMAGENT_CODEX_ACP: "1", CODEX_PATH: executable,
    INITIAL_AGENT_MODE: mode, CODEX_CONFIG: JSON.stringify({ sandbox_mode: sandbox, approval_policy: "never",
      ...(args.model ? { model: args.model } : {}), ...(args.effort ? { model_reasoning_effort: args.effort } : {}) }),
    ...(args.providerHome ? { CODEX_HOME: args.providerHome } : {}) });
  let sessionId = args.resumeId;
  const event = (kind: "status" | "tool_call" | "tool_result" | "error" | "result", payload: unknown) =>
    emit({ taskId: args.taskId, sessionId, kind, payload });
  const questions = new CodexAcpQuestions(payload => emit({ taskId: args.taskId, sessionId, kind: "question", payload }),
    requestId => event("status", { subtype: "input_resolved", requestId }));
  let stopped = false, finished = false, prompting = false;
  let turnId: string | undefined;
  let first = args.messageId;
  let stoppedHook: ReturnType<typeof codexHookStop>;
  let usage: Record<string, number> | undefined;
  let deadline: NodeJS.Timeout | undefined;
  let pending = false, uncertain = false;
  let supportsSteer = false;
  const delivered = (messageId: string) => event("status", { subtype: "message_delivered", messageId });

  function update(value: SessionUpdate) {
    switch (value.sessionUpdate) {
      case "agent_message_chunk":
        if (value.content.type === "text") emit({ taskId: args.taskId, sessionId, kind: "assistant_text",
          payload: { text: value.content.text, messageId: value.messageId ?? undefined } });
        break;
      case "tool_call":
      case "tool_call_update": {
        if (value.sessionUpdate === "tool_call") {
          const input = value.rawInput as { command?: unknown } | undefined;
          event("tool_call", { id: value.toolCallId, name: value.kind === "execute" ? "bash" : value.title,
            command: input?.command, input: value.rawInput, status: value.status,
            ...(value.kind === "edit" ? { changes: value.content?.filter(block => block.type === "diff") } : {}) });
        }
        if (value.status === "completed" || value.status === "failed") {
          const result = value.rawOutput as { formatted_output?: unknown; exit_code?: unknown } | undefined;
          event("tool_result", { tool_use_id: value.toolCallId, output: result?.formatted_output, exit_code: result?.exit_code,
            content: value.rawOutput ?? value.content, is_error: value.status === "failed" });
        }
        break;
      }
      case "session_info_update": {
        if (typeof value._meta?.palmagentNotice === "string") event("status", { subtype: "warning", text: value._meta.palmagentNotice });
        const parsed = lifecycle.safeParse(value._meta?.palmagentCodex);
        if (!parsed.success) return;
        const data = parsed.data;
        switch (data.method) {
          case "turn/started":
            turnId = data.turnId;
            clearTimeout(deadline);
            event("status", { subtype: "turn_started", turnId });
            if (first) { delivered(first); first = undefined; }
            break;
          case "hook/completed":
            if (turnId && data.turnId !== turnId) return;
            stoppedHook = codexHookStop(data);
            if (stoppedHook) event("error", stoppedHook);
            break;
          case "thread/tokenUsage/updated": {
            const last = data.tokenUsage.last;
            usage = { input_tokens: last.inputTokens, cached_input_tokens: last.cachedInputTokens, output_tokens: last.outputTokens };
            event("status", { subtype: "usage", usage: data.tokenUsage });
            break;
          }
          default: {
            const phase = data.phase === "commentary" ? "progress" : data.phase === "partial_answer" ? "partial" : data.phase === "final_answer" ? "final" : undefined;
            if (phase) event("status", { subtype: "assistant_message", messageId: data.messageId, phase });
          }
        }
      }
    }
  }

  const app = client({ name: "palmagent" })
    .onNotification("session/update", ({ params }) => {
      if (prompting && params.sessionId === sessionId) update(params.update);
    })
    .onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }))
    .onRequest("elicitation/create", ({ params, requestId, signal }) => prompting && !stopped && "sessionId" in params && params.sessionId === sessionId
      ? questions.request(String(requestId), params, signal) : { action: "decline" });
  const connection = app.connect(peer.stream);
  peer.onError(error => connection.close(error));
  const rpc = connection.agent;
  const setup = { cancellationSignal: AbortSignal.timeout(30_000), stopWaitingOnCancel: true };
  const done = (async () => {
    let code = 0;
    try {
      const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }, setup);
      if (init.protocolVersion !== 1 || init._meta?.palmagentCodex !== 1) throw new Error("Codex ACP bridge does not support the required Palmagent turn settings.");
      supportsSteer = (init._meta.steering as { supported?: boolean } | undefined)?.supported === true;
      const options = [{ configId: "mode", value: mode }];
      if (args.model) options.push({ configId: "model", value: args.model });
      if (args.effort) options.push({ configId: "reasoning_effort", value: args.effort });
      const params = { cwd: args.cwd, mcpServers: [], configOptions: options };
      const session = sessionId ? await rpc.request<ResumeSessionResponse>("session/resume", { ...params, sessionId }, setup) : await rpc.request<NewSessionResponse>("session/new", params, setup);
      if (!sessionId && "sessionId" in session && typeof session.sessionId === "string") sessionId = session.sessionId;
      if (!sessionId) throw new Error("Missing Codex thread ID.");
      // Catalog entries can omit custom gateway models. The bridge also pins the
      // requested model and effort on the native turn/start request.
      if (session.configOptions?.find(option => option.id === "mode")?.currentValue !== mode) {
        await rpc.request("session/set_mode", { sessionId, modeId: mode }, setup);
      }
      if (stopped) return;
      event("status", { subtype: "thread_started" });
      prompting = true;
      deadline = setTimeout(() => connection.close(new Error("Codex did not start the requested turn.")), 30_000);
      const result = await rpc.request("session/prompt", { sessionId, prompt: prompt(args.prompt, args.images, args.skills) });
      if (first && result.stopReason === "end_turn") delivered(first);
      const status = result.stopReason === "end_turn" ? "completed" : result.stopReason === "cancelled" ? "interrupted" : result.stopReason;
      event("result", { subtype: stoppedHook ? "hook_stopped" : status,
        is_error: !!stoppedHook || result.stopReason !== "end_turn", usage,
        ...(stoppedHook ? { providerStatus: "completed", error: { message: stoppedHook.message } } : {}) });
    } catch (error) {
      if (!stopped) { code = 1; event("error", { code: TURN_RESULT_MISSING, message: String(error) }); }
    } finally {
      finished = true;
      clearTimeout(deadline);
      connection.close();
      await peer.close();
      event("status", { subtype: "process_exit", code });
    }
  })();
  function stop() {
    if (stopped || finished) return false;
    stopped = true;
    clearTimeout(deadline);
    if (prompting && sessionId) {
      deadline = setTimeout(() => connection.close(), 2000);
      void rpc.notify("session/cancel", { sessionId }).catch(() => connection.close());
    } else connection.close();
    return true;
  }
  return { done, interrupt: stop, cancel: stop, steer: () => false, approve: () => false,
    answer: req => !stopped && !finished && questions.answer(req),
    async send(text, images, id, skills): Promise<Receipt> {
      if (!args.interactive || !supportsSteer || !sessionId || !turnId || finished || stopped || pending || uncertain || text.trimStart().startsWith("/")) return "rejected";
      pending = true;
      try {
        const result = await rpc.request<{ outcome: string }>("_session/steering", { sessionId, prompt: prompt(text, images, skills),
          _meta: { steering: { idleBehavior: "promptRequired" } } }, { cancellationSignal: AbortSignal.timeout(15_000), stopWaitingOnCancel: true });
        if (result.outcome === "injected") { delivered(id); return "delivered"; }
        if (result.outcome === "promptRequired") return "rejected";
      } catch { /* A disconnected request may already have reached the provider. */ }
      finally { pending = false; }
      uncertain = true;
      return "unknown";
    } };
}
