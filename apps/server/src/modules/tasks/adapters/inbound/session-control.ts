import { request } from "node:http";
import { lstatSync } from "node:fs";
import { sessionSocket } from "../../../../platform/ipc/session-socket.js";
export { sessionSocket } from "../../../../platform/ipc/session-socket.js";
import type { DeliverSessionImage, DispatchSessionRequest } from "@palmagent/shared";

type DispatchResponse = { task: { taskId: string; sessionControl?: { owner: string; connection?: string; error?: string } } };

export function localSessionRequest(dataDir: string, body: DispatchSessionRequest): Promise<DispatchResponse> {
  return postSessionRequest(dataDir, "/dispatch", body);
}
export function deliverLocalImage(dataDir: string, body: DeliverSessionImage): Promise<{ taskId: string; attachmentId: string }> {
  return postSessionRequest(dataDir, "/deliver-image", body);
}
function postSessionRequest<T>(dataDir: string, path: string, body: DispatchSessionRequest | DeliverSessionImage): Promise<T> {
  return new Promise((resolve, reject) => {
    const stat = lstatSync(sessionSocket(dataDir));
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("Session control socket must be private and owned by this account");
    const req = request({ socketPath: sessionSocket(dataDir), path, method: "POST", headers: { "content-type": "application/json" }, timeout: 10_000 }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; if (text.length > 1_000_000) req.destroy(new Error("Control response too large")); });
      res.on("end", () => {
        try { const value = JSON.parse(text); if (res.statusCode !== 200) reject(new Error(value.error ?? "Session request failed")); else resolve(value); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Local session control timed out")));
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
