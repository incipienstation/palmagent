import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const sessionId = "937ebda2-5489-4f8e-b36b-f89a71fda3c1";
const record = value => appendFileSync(join(process.env.PROBE_CONTROL, "acp.jsonl"), JSON.stringify(value) + "\n");
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
let prompt;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
      break;
    case "session/new":
    case "session/resume":
      record({ method, sessionId: params.sessionId });
      send({ id, result: { sessionId } });
      break;
    case "session/set_mode":
      record({ mode: params.modeId });
      send({ id, result: {} });
      break;
    case "session/prompt":
      record({ method, pid: process.pid });
      prompt = id;
      send({ id: "permission", method: "session/request_permission", params: { sessionId,
        toolCall: { toolCallId: "tool", title: "Edit", rawInput: { file: "example.txt" } },
        options: [{ optionId: "always", name: "Always allow", kind: "allow_always" },
          { optionId: "once", name: "Allow once", kind: "allow_once" }] } });
      break;
    case "session/cancel":
      record({ method });
      send({ id: prompt, result: { stopReason: "cancelled" } });
      break;
    case undefined:
      if (id === "permission") {
        record({ decision: result?.outcome?.optionId, pid: process.pid });
        send({ id: "choice", method: "elicitation/create", params: { mode: "form", sessionId, message: "Continue?",
          requestedSchema: { type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "Yes", title: "Yes" }] },
            question_0_custom: { type: "string" } } } } });
      }
      if (id === "choice") {
        record({ answer: result?.content });
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "continued" } } } });
        send({ id: prompt, result: { stopReason: "end_turn" } });
      }
      break;
  }
}
