import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InstallConfig } from "./config.js";
import { connectionInfo } from "./connection.js";

export interface ApplicationIdentity {
  version: string;
  sourceCommit: string;
  files: Record<string, string>;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Capture expected bytes before activation, independently of the served shell. */
export function applicationIdentity(directory: string): ApplicationIdentity {
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const build = JSON.parse(readFileSync(join(directory, "build-info.json"), "utf8"));
  if (typeof pkg.version !== "string" || build.version !== pkg.version || build.dirty !== false ||
      !/^[a-f0-9]{40}$/.test(build.sourceCommit ?? "")) throw new Error("Installed package has no valid clean build identity");
  const shell = readFileSync(join(directory, "web/index.html"));
  const scripts = [...shell.toString().matchAll(/<script\b[^>]*\bsrc="(\/assets\/[\w.-]+\.js)"/g)].map(match => match[1]!);
  if (!scripts.length) throw new Error("Installed PWA has no entry script");
  const files: Record<string, string> = { "/": hash(shell) };
  for (const path of scripts) files[path] = hash(readFileSync(join(directory, "web", path.slice(1))));
  return { version: build.version, sourceCommit: build.sourceCommit, files };
}

/** Never follow ingress redirects or trust asset paths supplied by the server. */
export async function verifyApplication(identity: ApplicationIdentity, origin: string, request: typeof fetch = fetch): Promise<void> {
  const get = async (path: string) => {
    const response = await request(`${origin}${path}`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Application verification HTTP failure: ${path}`);
    return response;
  };
  const health = await (await get("/api/health")).json() as { ok?: boolean; build?: { version?: string; sourceCommit?: string; dirty?: boolean } };
  if (health.ok !== true || health.build?.version !== identity.version || health.build.sourceCommit !== identity.sourceCommit || health.build.dirty !== false)
    throw new Error("Running application differs from the installed build");
  for (const [path, expected] of Object.entries(identity.files)) {
    if (hash(new Uint8Array(await (await get(path)).arrayBuffer())) !== expected)
      throw new Error(`Served PWA differs from the installed package: ${path}`);
  }
}

export async function applicationChecks(cfg: InstallConfig, request: typeof fetch = fetch) {
  if (cfg.mode !== "package") return [];
  const checks: { name: string; level: "ok" | "fail"; detail: string }[] = [];
  let identity: ApplicationIdentity;
  try { identity = applicationIdentity(cfg.pkgDir!); }
  catch {
    return [{ name: "package identity", level: "fail" as const, detail: "Package build identity or PWA files are missing or invalid" }];
  }
  const connection = connectionInfo(cfg);
  for (const [name, origin] of [["local application", connection.upstream], ["public application", connection.publicOrigin]] as const) {
    try {
      await verifyApplication(identity, origin, request);
      checks.push({ name, level: "ok", detail: `${identity.version} (${identity.sourceCommit}); build and PWA hashes verified` });
    } catch {
      checks.push({ name, level: "fail", detail: "Build identity, health, or served PWA verification failed" });
    }
  }
  return checks;
}
