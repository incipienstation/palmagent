import type { AgentKind } from "@palmagent/shared";
import type { SessionLabel, SessionTitleTarget } from "../../application/ports/outbound/native-session.js";
import { readNdjsonQuery } from "../../../../platform/process/ndjson-query.js";
import { fileURLToPath } from "node:url";

export async function readSessionTitles(agent: AgentKind, home: string, targets: SessionTitleTarget[], signal?: AbortSignal) {
  if (agent === "claude") {
    // The SDK selects its metadata store through CLAUDE_CONFIG_DIR. Isolate
    // each batch so concurrent reads can use different pinned provider homes.
    const rows = await readNdjsonQuery({
      signal, command: process.execPath, args: [fileURLToPath(new URL("./claude-session-titles.mjs", import.meta.url))],
      env: { CLAUDE_CONFIG_DIR: home }, timeoutMs: 10_000,
      errors: { unavailable: "Claude metadata reader unavailable", channel: "Session metadata channel closed",
        timeout: "Session metadata read timed out", tooLarge: "Session metadata too large", exited: "Session metadata reader exited" },
      initialize: ({ send }) => send(targets),
      receive(message, { finish }) { finish(undefined, message.labels); },
    }) as [string, SessionLabel][];
    return new Map(rows);
  }

  // Read only the requested threads, sharing one app-server per batch. A
  // missing thread must not discard successful replies for its neighbours.
  const labels = new Map<string, SessionLabel>();
  let pending = targets.length;
  await readNdjsonQuery({
    signal, command: "codex", args: ["app-server", "--listen", "stdio://"], env: { CODEX_HOME: home },
    timeoutMs: 10_000, directoryPrefix: "palmagent-thread-names-",
    errors: { unavailable: "Codex unavailable", channel: "Thread read channel closed", timeout: "Thread read timed out",
      tooLarge: "Thread metadata too large", exited: "Thread reader exited" },
    initialize: ({ send }) => send({ id: 0, method: "initialize", params: { clientInfo: { name: "palmagent", version: "1" }, capabilities: {} } }),
    receive(message, { send, finish }) {
      if (message.id === 0) {
        if (message.error) return finish();
        send({ method: "initialized" });
        targets.forEach(({ sessionId }, i) => send({ id: i + 1, method: "thread/read", params: { threadId: sessionId, includeTurns: false } }));
      } else if (typeof message.id === "number" && targets[message.id - 1]) {
        const target = targets[message.id - 1];
        const thread = (message.result as { thread?: { id?: string; name?: string | null; preview?: string } } | undefined)?.thread;
        if (thread?.id === target.sessionId && (thread.name == null || typeof thread.name === "string")) {
          labels.set(target.sessionId, { title: thread.name ?? null, firstPrompt: typeof thread.preview === "string" ? thread.preview : undefined });
        }
        if (--pending === 0) finish();
      }
    },
  }).catch(() => undefined);
  return labels;
}
