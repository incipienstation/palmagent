import { randomUUID } from "node:crypto";
import { startAcpProcess, type AcpBridge } from "./acp-process.js";
import { client, type ContentBlock, type NewSessionRequest } from "@agentclientprotocol/sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk/core";
import { normalizePermission, sampledAgentInput, type InputAttachment } from "@palmagent/shared";
import { z } from "zod";
import type { AgentRunner } from "../../application/ports/outbound/provider-process.js";
import type { StartArgs, Emit } from "../../domain/execution.js";
import type { RunHandle } from "../../domain/run-handle.js";
import { claudeSkillPrompt } from "./claude-messages.js";
import { claudeOutput } from "./claude-output.js";
import { ClaudeAcpInput } from "./claude-acp-input.js";

type Receipt = "delivered" | "rejected" | "unknown";
const sdkFrame = z.object({ sessionId: z.string(), message: z.looseObject({ type: z.string() }) });
function content(text: string, images?: InputAttachment[]): ContentBlock[] {
  const input = sampledAgentInput(text, images);
  return [{ type: "text", text: input.text }, ...input.images.map(image =>
    ({ type: "image" as const, data: image.data, mimeType: image.mediaType }))];
}

function matchesEcho(prompt: ContentBlock[], echoed: Extract<SDKMessage, { type: "user" }>["message"]["content"]) {
  if (typeof echoed === "string") return prompt.length === 1 && prompt[0].type === "text" && prompt[0].text === echoed;
  return echoed.length === prompt.length && echoed.every((block, i) => {
    const expected = prompt[i];
    if (block.type === "text") return expected.type === "text" && block.text === expected.text;
    return block.type === "image" && block.source.type === "base64" && expected.type === "image"
      && block.source.media_type === expected.mimeType && block.source.data === expected.data;
  });
}

/** The retained execution host owns the bridge for a whole turn. The API
 * reconnects to that host's journal, never to a second Claude process. */
export function claudeAcpRunner(bridge: AcpBridge, executable: string): AgentRunner {
  return { agent: "claude", start: (args, emit) => startClaudeAcp(bridge, executable, args, emit) };
}

function startClaudeAcp(bridge: AcpBridge, executable: string, args: StartArgs, emit: Emit): RunHandle {
  const peer = startAcpProcess(bridge, args.cwd, { ...process.env, CLAUDE_CODE_EXECUTABLE: executable,
    CLAUDE_AGENT_ACP_PROTOCOL: "v1", ...(args.providerHome ? { CLAUDE_CONFIG_DIR: args.providerHome } : {}) });
  let sessionId = args.resumeId, stopped = false, running = false, supportsSteer = false;
  const taskId = args.taskId;
  const project = claudeOutput(args);
  const input = new ClaudeAcpInput(event => emit({ ...event, taskId, sessionId }));
  let finished = false;
  let cancelTimeout: NodeJS.Timeout | undefined;
  let pending: { blocks: ContentBlock[]; id: string; resolve: (r: Receipt) => void } | undefined;
  function confirm(id: string) {
    emit({ taskId, sessionId, kind: "status", payload: { subtype: "message_delivered", messageId: id } });
  }
  // The provider chooses native message UUIDs. Only a matching user echo
  // confirms delivery, not the bridge acknowledging that it queued a steer.
  let first = args.messageId;
  let uncertainDelivery = false;
  const prompt = content(claudeSkillPrompt(args.prompt, args.skills), args.images);
  const seenEchoes = new Set<string>();
  let messageId: string | undefined;
  const app = client({ name: "palmagent" })
    .onNotification("session/update", ({ params }) => {
      const update = params.update;
      if (running && params.sessionId === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        emit({ taskId, sessionId, kind: "assistant_text", payload: { text: update.content.text, messageId: messageId ?? update.messageId ?? undefined } });
      }
    })
    .onRequest("session/request_permission", ({ requestId, params, signal }) =>
      running && !stopped && params.sessionId === sessionId ? input.permission(String(requestId), params, signal) : { outcome: { outcome: "cancelled" } })
    .onRequest("elicitation/create", ({ requestId, params, signal }) =>
      running && !stopped && "sessionId" in params && params.sessionId === sessionId ? input.question(String(requestId), params, signal) : { action: "cancel" })
    .onNotification("_claude/sdkMessage", sdkFrame, ({ params }) => {
      if (!running || params.sessionId !== sessionId) return;
      const message = params.message as SDKMessage;
      if (message.type === "user" && message.uuid && !message.parent_tool_use_id &&
          "isReplay" in message && message.isReplay && !seenEchoes.has(message.uuid)) {
        seenEchoes.add(message.uuid);
        if (first && matchesEcho(prompt, message.message.content)) {
          const id = first;
          first = undefined;
          confirm(id);
        } else if (pending && matchesEcho(pending.blocks, message.message.content)) {
          confirm(pending.id);
          pending.resolve("delivered");
        }
      }
      // Use the provider's metadata extension for the same message phases,
      // tool ids and accounting as existing Claude transcripts.
      if (message.type === "result") lastResult = message;
      else if (message.type === "stream_event" && message.event?.type === "content_block_delta") return;
      else {
        if (message.type === "stream_event" && message.event?.type === "message_start") messageId = message.event.message.id;
        project(message, sessionId, emit);
      }
    });
  let lastResult: Extract<SDKMessage, { type: "result" }> | undefined;
  const connection = app.connect(peer.stream);
  peer.onError(error => connection.close(error));
  const rpc = connection.agent;
  const setup = { cancellationSignal: AbortSignal.timeout(30_000), stopWaitingOnCancel: true };
  const mode = normalizePermission("claude", args.permission);
  const done = (async () => {
    let code = 0;
    try {
      const init = await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }, setup);
      if (init.protocolVersion !== 1) throw new Error("Claude adapter did not negotiate ACP v1.");
      supportsSteer = (init._meta?.steering as { supported?: boolean })?.supported === true;
      const params: NewSessionRequest = { cwd: args.cwd, mcpServers: [], _meta: { claudeCode: { emitRawSDKMessages: true,
        options: { allowDangerouslySkipPermissions: mode === "bypassPermissions", ...(args.model ? { model: args.model } : {}) } } } };
      const session = sessionId
        ? await rpc.request("session/resume", { ...params, sessionId }, setup)
        : await rpc.request("session/new", params, setup);
      if ("sessionId" in session && typeof session.sessionId === "string") sessionId = session.sessionId;
      if (!sessionId) throw new Error("Claude adapter returned no session.");
      const modeId = mode === "manual" ? "default" : mode;
      if (session.modes?.currentModeId !== modeId) await rpc.request("session/set_mode", { sessionId, modeId }, setup);
      if (args.effort) await rpc.request("session/set_config_option", { sessionId, configId: "effort", value: args.effort }, setup);
      if (stopped) return;
      emit({ taskId, sessionId, kind: "status", payload: { subtype: "init" } });
      running = true;
      const result = await rpc.request("session/prompt", { sessionId, prompt });
      if (first && result.stopReason === "end_turn") confirm(first);
      if (lastResult) project(lastResult, sessionId, emit);
      else emit({ taskId, sessionId, kind: "result", payload: { subtype: result.stopReason, is_error: result.stopReason !== "end_turn" } });
    } catch (error) {
      code = stopped ? 0 : 1;
      if (!stopped) emit({ taskId, sessionId, kind: "error", payload: { message: String(error) } });
    } finally {
      running = false;
      pending?.resolve("unknown");
      finished = true;
      clearTimeout(cancelTimeout);
      connection.close();
      await peer.close();
      emit({ taskId, sessionId, kind: "status", payload: { subtype: "process_exit", code } });
    }
  })();
  function stop() {
    if (stopped || finished) return false;
    stopped = true;
    if (running && sessionId) {
      cancelTimeout = setTimeout(() => connection.close(), 2000);
      void rpc.notify("session/cancel", { sessionId }).catch(() => connection.close());
    } else connection.close();
    return true;
  }
  function send(text: string, images: InputAttachment[] | undefined, id: string): Promise<Receipt> {
    if (!running || !sessionId || stopped || !supportsSteer || uncertainDelivery || pending || first) return Promise.resolve("rejected");
    const blocks = content(text, images);
    const target = sessionId;
    return new Promise(resolve => {
      const timer = setTimeout(() => finish("unknown"), 15_000);
      const finish = (receipt: Receipt) => {
        if (pending?.id !== id) return;
        clearTimeout(timer); pending = undefined;
        if (receipt === "unknown") uncertainDelivery = true;
        resolve(receipt);
      };
      pending = { blocks, id, resolve: finish };
      void rpc.request<{ outcome: string }>("_session/steering", { sessionId: target, prompt: blocks,
        _meta: { steering: { idleBehavior: "promptRequired" } } }).then(result => {
        if (result.outcome === "promptRequired") finish("rejected");
      }, () => finish("unknown"));
    });
  }
  return { done, interrupt: stop, cancel: stop,
    approve: decision => !stopped && input.approve(decision), answer: answer => !stopped && input.answer(answer),
    send: (text, images, id, skills) => args.interactive ? send(claudeSkillPrompt(text, skills), images, id) : Promise.resolve("rejected"),
    steer(text, images) {
      if (!running || stopped || !supportsSteer || uncertainDelivery || pending || first) return false;
      void send(text, images, randomUUID()); return true;
    } };
}
