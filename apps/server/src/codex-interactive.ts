import type { ImageAttachment, QuestionRequest } from "@palmagent/shared";
import type { Emit, RawEvent, RunHandle, RunnerBackend, StartArgs } from "./types.js";

export const codexInput = (text: string, images?: ImageAttachment[], skills?: StartArgs["skills"]) => [
  { type: "text", text: [...(skills ?? []).map(s => `$${s.name}`), text].join("\n"), text_elements: [] },
  ...(skills ?? []).map(s => ({ type: "skill", name: s.name, path: s.path })),
  ...(images ?? []).map(i => ({ type: "image", url: `data:${i.mediaType};base64,${i.data}` })),
];

// One app-server process per Palmagent run keeps the existing daemon ownership
// boundary. Native turn completion closes stdin; a process exit by itself never
// establishes success. The daemon's stdout replay reconstructs RPC/turn IDs.
export function startCodexInteractive(args: StartArgs, emit: Emit, backend: RunnerBackend): RunHandle {
  const { taskId, reattach } = args;
  let sessionId = args.resumeId;
  let turnId: string | undefined;
  let completed = false;
  let usage: Record<string, number> | undefined;
  const pending = new Map<string, { resolve: (s: "delivered" | "rejected" | "unknown") => void; timer: ReturnType<typeof setTimeout> }>();
  const questions = new Map<string, QuestionRequest>();
  if (reattach && args.pendingInput) questions.set(args.pendingInput.requestId, args.pendingInput);
  const permission = args.permission;
  const sandbox = permission === "read-only" || permission === "readonly" ? "read-only"
    : permission === "danger-full-access" || permission === "full" ? "danger-full-access" : "workspace-write";
  const proc = reattach ? backend.attach(taskId, 0) : backend.start({
    turnId: taskId, command: "codex", cwd: args.cwd,
    argv: ["app-server", "--listen", "stdio://", "-c", 'approval_policy="never"',
      "-c", `sandbox_mode=${JSON.stringify(sandbox)}`,
      ...(permission === "workspace-write-net" ? ["-c", "sandbox_workspace_write.network_access=true"] : [])],
    ...(args.providerHome ? { env: { CODEX_HOME: args.providerHome } } : {}),
  });
  if (!proc) {
    emit({ taskId, kind: "status", sessionId, payload: { subtype: "reattach_failed" } });
    return { steer: () => false, interrupt: () => false, approve: () => false, answer: () => false, cancel() {}, done: Promise.resolve() };
  }
  const write = (v: unknown) => proc.writeStdin(JSON.stringify(v) + "\n");
  const rpc = (id: string, method: string, params: unknown) => write({ jsonrpc: "2.0", id, method, params });
  const event = (kind: RawEvent["kind"], payload: unknown, seq?: number) => emit({ taskId, sessionId, kind, payload }, seq);
  const delivery = (messageId: string, seq?: number) => {
    event("status", { subtype: "message_delivered", messageId }, seq);
    const p = pending.get(messageId);
    if (p) { clearTimeout(p.timer); pending.delete(messageId); p.resolve("delivered"); }
  };
  let startup = setTimeout(() => {
    if (!turnId && !completed) { event("error", { message: "Codex did not start a turn; the request will not be replayed automatically." }); proc.kill("SIGINT"); }
  }, 30_000);
  startup.unref();
  proc.onLine((seq, line) => {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    const p = ev.params ?? {};
    // RPC responses are also in daemon replay, including delivery receipts.
    if (typeof ev.id === "string" && ("result" in ev || "error" in ev)) {
      if (ev.id.startsWith("message:")) {
        const messageId = ev.id.slice(8), pendingMessage = pending.get(messageId);
        if (ev.error) { if (pendingMessage) { clearTimeout(pendingMessage.timer); pending.delete(messageId); pendingMessage.resolve("rejected"); } }
        else delivery(messageId, seq);
      } else if (ev.error) {
        event("error", { message: ev.error.message ?? "Codex request failed" }, seq);
        completed = true; proc.closeStdin();
      } else if (ev.id === "initialize" && !reattach) {
        write({ jsonrpc: "2.0", method: "initialized", params: {} });
        rpc("session", args.resumeId ? "thread/resume" : "thread/start", {
          ...(args.resumeId ? { threadId: args.resumeId } : {}), cwd: args.cwd,
          approvalPolicy: "never", sandbox, ...(args.model ? { model: args.model } : {}),
          ...(args.effort ? { config: { model_reasoning_effort: args.effort } } : {}),
        });
      } else if (ev.id === "session") {
        sessionId = ev.result.thread.id;
        event("status", { subtype: "thread_started" }, seq);
        if (!reattach) rpc("start", "turn/start", { threadId: sessionId, input: codexInput(args.prompt, args.images, args.skills),
          ...(args.messageId ? { clientUserMessageId: args.messageId } : {}),
          ...(args.effort ? { effort: args.effort } : {}) });
      } else if (ev.id === "start") {
        turnId = ev.result.turn.id; clearTimeout(startup);
        if (args.messageId) delivery(args.messageId, seq);
      }
      return;
    }
    if (p.threadId && sessionId && p.threadId !== sessionId) return;
    switch (ev.method) {
      case "thread/started":
        sessionId = p.thread.id; event("status", { subtype: "thread_started" }, seq); break;
      case "turn/started":
        turnId = p.turn.id; clearTimeout(startup); event("status", { subtype: "turn_started", turnId }, seq); break;
      case "item/agentMessage/delta":
        event("assistant_text", { text: p.delta, messageId: p.itemId }, seq); break;
      case "item/started":
        if (p.item?.type === "commandExecution") event("tool_call", { id: p.item.id, name: "bash", command: p.item.command }, seq);
        break;
      case "item/completed": {
        const item = p.item;
        if (item?.type === "userMessage" && item.clientId) delivery(item.clientId, seq);
        else if (item?.type === "agentMessage") event("status", { subtype: "assistant_message", messageId: item.id,
          phase: item.phase === "commentary" ? "progress" : item.phase === "final_answer" ? "final" : undefined }, seq);
        else if (item?.type === "commandExecution") event("tool_result", { tool_use_id: item.id, output: item.aggregatedOutput, exit_code: item.exitCode }, seq);
        else if (item?.type === "fileChange") event("tool_call", { id: item.id, name: "file_change", changes: item.changes }, seq);
        else if (item?.type === "mcpToolCall" || item?.type === "webSearch") event("tool_result", { tool_use_id: item.id, content: item.result ?? item.action, name: item.tool ?? item.type }, seq);
        // Reasoning payloads are never converted into assistant text.
        break;
      }
      case "turn/completed":
        completed = true; turnId = undefined; questions.clear(); clearTimeout(startup);
        if (p.turn.status === "failed") event("error", { message: p.turn.error?.message ?? "Codex turn failed." }, seq);
        event("result", { is_error: p.turn.status !== "completed", subtype: p.turn.status, error: p.turn.error, usage }, seq);
        proc.closeStdin(); break;
      case "thread/tokenUsage/updated":
        if (p.tokenUsage?.last) usage = { input_tokens: p.tokenUsage.last.inputTokens, cached_input_tokens: p.tokenUsage.last.cachedInputTokens, output_tokens: p.tokenUsage.last.outputTokens };
        event("status", { subtype: "usage", usage: p.tokenUsage }, seq); break;
      case "error": event("error", { message: p.error?.message ?? p.message }, seq); break;
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        write({ jsonrpc: "2.0", id: ev.id, result: { decision: "decline" } }); break;
      case "item/tool/requestUserInput": {
        if (typeof ev.id !== "string" && typeof ev.id !== "number") break;
        // Encode the RPC id without losing whether it was numeric or a string.
        const requestId = JSON.stringify(ev.id);
        if (reattach && seq <= (args.resumeFromSeq ?? 0)) break;
        if (!Array.isArray(p.questions)) break;
        const question: QuestionRequest = { requestId, questions: p.questions.map((q: any) => ({
          id: q.id, question: q.question, header: q.header, options: q.options ?? [],
        })) };
        questions.set(requestId, question);
        event("question", question, seq);
        break;
      }
      case "serverRequest/resolved": {
        const requestId = JSON.stringify(p.requestId);
        questions.delete(requestId);
        event("status", { subtype: "input_resolved", requestId }, seq);
        break;
      }
    }
  });
  proc.onStderr(text => event("status", { subtype: "stderr", text }));
  const done = new Promise<void>(resolve => proc.onExit(code => {
    clearTimeout(startup);
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve("unknown"); }
    pending.clear(); questions.clear();
    if (!completed) event("error", { message: "Codex exited before a terminal turn result." });
    event("status", { subtype: "process_exit", code }); resolve();
  }));
  if (!reattach) rpc("initialize", "initialize", { clientInfo: { name: "palmagent", version: "1.0.0" }, capabilities: {} });
  return {
    send: (text, images, messageId, skills) => {
      if (!turnId || completed || !proc.stdinWritable()) return Promise.resolve("rejected");
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(messageId); resolve("unknown"); }, 15_000); timer.unref();
        pending.set(messageId, { resolve, timer });
        if (!rpc(`message:${messageId}`, "turn/steer", { threadId: sessionId, expectedTurnId: turnId, clientUserMessageId: messageId, input: codexInput(text, images, skills) })) {
          clearTimeout(timer); pending.delete(messageId); resolve("unknown");
        }
      });
    },
    steer: () => false,
    interrupt: () => !!turnId && !completed && rpc(`stop:${turnId}`, "turn/interrupt", { threadId: sessionId, turnId }),
    approve: () => false,
    answer: (req) => {
      const question = questions.get(req.requestId);
      if (!question || completed || !proc.stdinWritable()) return false;
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of question.questions) {
        if (!q.id) return false;
        const matching = req.answers.filter(a => a.questionId ? a.questionId === q.id : a.question === q.question);
        // Legacy clients can identify unique question text, but must not guess
        // when two provider questions have the same wording.
        const a = matching[0];
        if (matching.length > 1 || (a && !a.questionId && question.questions.filter(other => other.question === q.question).length > 1)) return false;
        const values = [...(a?.selected ?? []), ...[a?.notes?.trim(), req.response?.trim()].filter((s): s is string => !!s)];
        if (values.length) answers[q.id] = { answers: values };
      }
      if (!write({ jsonrpc: "2.0", id: JSON.parse(req.requestId), result: { answers } })) return false;
      questions.delete(req.requestId);
      return true;
    },
    cancel: () => proc.kill("SIGINT"), done,
  };
}
