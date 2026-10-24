import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";

/** Private owner-only HTTP transport; match the native canonical-path socket identity. */
export function applicationSocket(dataDir: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Application runtime requires a Unix installation owner");
  const hash = createHash("sha256").update(realpathSync(dataDir)).digest("hex").slice(0, 20);
  const directory = `/tmp/palmagentd-${uid}-${hash}`, socket = join(directory, "application.sock");
  for (const path of [directory, socket]) {
    const stat = lstatSync(path);
    if (stat.uid !== uid || (stat.mode & 0o077) || (path === directory ? !stat.isDirectory() : !stat.isSocket())) {
      throw new Error("Application endpoint must be private and owned by the installation user");
    }
  }
  return socket;
}

export function applicationRequest(dataDir: string, path: string, method = "GET", input?: unknown): Promise<{ status: number; value: unknown }> {
  const socketPath = applicationSocket(dataDir);
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { "content-type": "application/json" }, timeout: 15_000 }, res => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) req.destroy(new Error("Application response is too large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 500, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Invalid application response")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Application request timed out; delivery is unconfirmed")));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
