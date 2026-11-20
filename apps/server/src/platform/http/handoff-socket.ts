import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Server as HttpServer } from "node:http";
import { join } from "node:path";

export const handoffSocket = (directory: string) => join(directory, "public-api.sock");

/** Feed authenticated public HTTP and WebSocket traffic to the regular listener.
 * The caller holds runtime.lock, including while retiring a dead owner's socket. */
export async function openHandoffSocket(directory: string, http: HttpServer) {
  const path = handoffSocket(directory);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Unexpected public API socket owner");
    unlinkSync(path);
  }
  const server = createServer(client => http.emit("connection", client));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(path, 0o600);
  // HTTP runtime shutdown owns the connected sockets and its bounded close deadline.
  return () => { server.close(); };
}
