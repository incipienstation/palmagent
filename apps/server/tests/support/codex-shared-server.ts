import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createInputFiles } from "../../src/modules/agents/adapters/outbound/input-files.js";
import { CodexSharedSessions } from "../../src/modules/agents/adapters/outbound/codex-shared-session.js";

export async function sharedCodexServer(t: test.TestContext, options: { loaded?: boolean; paginated?: boolean; onInput?: (params: any) => void } = {}) {
  const home = mkdtempSync(join(tmpdir(), "palmagent-shared-contract-"));
  const server = new WebSocketServer({ port: 0, host: "localhost" });
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const config: Record<string, unknown> = { model: "configured-model", model_reasoning_effort: "medium" };
  const requests: Array<{ id: number; method: string; params: any }> = [];
  const thread: any = { id: "session-1", cwd: home, historyMode: options.paginated ? "paginated" : "legacy", canAcceptDirectInput: options.loaded !== false, status: { type: options.loaded === false ? "notLoaded" : "active" }, model: "fixture", reasoningEffort: "medium",
    turns: [{ id: "turn-1", status: "inProgress", items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "Original prompt" }] }] }] };
  let socket: WebSocket;
  let loseSend = false;
  const notify = (method: string, params: any, id?: string | number) => socket.send(JSON.stringify({ method, params: { threadId: thread.id, ...params }, ...(id === undefined ? {} : { id }) }));
  server.on("connection", ws => {
    socket = ws;
    ws.on("message", bytes => {
      const row = JSON.parse(String(bytes));
      if ("result" in row) { notify("serverRequest/resolved", { requestId: row.id }); return; }
      if (!row.method || row.id === undefined) return;
      requests.push(row);
      let result: any;
      switch (row.method) {
        case "config/read": result = { config }; break;
        case "model/list": result = { data: [{ model: "catalog-model", isDefault: true, defaultReasoningEffort: "high" }, { model: "selected-model", defaultReasoningEffort: "low" }], nextCursor: null }; break;
        case "initialize": result = { codexHome: home }; break;
        case "thread/read": result = { thread }; break;
        case "thread/resume":
          if (thread.status.type === "notLoaded") { thread.status = { type: "idle" }; thread.canAcceptDirectInput = true; }
          result = { thread }; break;
        case "thread/turns/list": result = { data: thread.turns, nextCursor: null }; break;
        case "turn/start": case "turn/steer":
          options.onInput?.(row.params);
          if (loseSend) { ws.close(); return; }
          result = { turn: { id: "turn-1" } }; break;
        case "turn/interrupt": result = {}; break;
        default: assert.fail(`Unexpected method: ${row.method}`);
      }
      ws.send(JSON.stringify({ id: row.id, result }));
    });
  });
  const connector = new CodexSharedSessions(undefined, () => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    return { ws, close: () => ws.terminate() };
  });
  const target = { taskId: "task-1", sessionId: thread.id, agent: "codex" as const, cwd: home, home };
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); createInputFiles(home, `shared\0${home}\0${thread.id}`).cleanup(); rmSync(home, { recursive: true, force: true }); });
  return { connector, target, requests, thread, config, notify, loseSend: () => { loseSend = true; } };
}
