import { createInterface } from "node:readline";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk/core";

const input = createInterface({ input: process.stdin });
input.once("line", async line => {
  input.close();
  const labels = [];
  for (const { sessionId, cwd } of JSON.parse(line)) {
    const info = await getSessionInfo(sessionId, { dir: cwd }).catch(() => undefined);
    if (info) labels.push([sessionId, {
      title: info.customTitle || (info.summary !== info.firstPrompt ? info.summary : null),
      firstPrompt: info.firstPrompt,
    }]);
  }
  process.stdout.write(JSON.stringify({ labels }) + "\n");
});
