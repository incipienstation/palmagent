import { createHostReadiness } from "../platform/process/host-readiness.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../composition/server.js";

declare const __PALMAGENT_BUILD__: { version: string; sourceCommit: string; dirty: boolean };
const build = typeof __PALMAGENT_BUILD__ === "undefined" ? undefined : __PALMAGENT_BUILD__;
const ready = createHostReadiness();
const packageDir = build ? dirname(fileURLToPath(import.meta.url)) : undefined;
const runtime = await startServer({ build, packageDir, view: {
  entry: packageDir ? join(packageDir, "view.js") : fileURLToPath(new URL("./view.ts", import.meta.url)),
  execArgv: packageDir ? [] : ["--import", "tsx"],
} });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void runtime.close().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
}

ready();
