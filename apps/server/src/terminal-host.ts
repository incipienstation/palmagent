import { resolve } from "node:path";
import { TerminalId, TERMINAL_PROTOCOL, TERMINAL_STARTUP_TIMEOUT_MS } from "@palmagent/shared/terminals";
import { TerminalStore } from "./terminal/store.js";
import { TerminalHost } from "./terminal/host.js";
import { terminalPlatform } from "./terminal/adapters.js";
import { processIdentity } from "./native-session.js";

const directory = process.argv[2];
const id = TerminalId.parse(process.argv[3]);
const platform = terminalPlatform(true);
if (!directory || !platform.supported) throw new Error("Unsupported terminal platform");
const store = new TerminalStore(resolve(directory));
const record = store.get(id);
if (!record || record.protocol !== TERMINAL_PROTOCOL) throw new Error("Terminal protocol mismatch");
const identity = processIdentity(process.pid);
if (!identity || !store.claim(id, process.pid, identity)) { store.close(); process.exit(1); }
let host: TerminalHost | undefined;
let unlisten: (() => void) | undefined;
let finishing = false;
let diagnosticExpiry: ReturnType<typeof setTimeout> | undefined;
function finish(code: number, lost = false) {
  if (finishing) return;
  finishing = true; clearTimeout(diagnosticExpiry); clearTimeout(startupExpiry);
  if (lost) store.noteStartError(id, "initialization_failed", "Shell initialization failed. Check the terminal service log.");
  store.update(id, { state: "closing", exitCode: lost ? undefined : code });
  // Allow the exit frame to reach attached clients before closing IPC.
  setTimeout(() => { host?.close(); unlisten?.(); store.close(); process.exit(lost ? 1 : 0); }, 50);
}
const startupExpiry = setTimeout(() => { store.expireStartup(id); host?.terminate(); finish(1, true); }, Math.max(1, record.createdAt + TERMINAL_STARTUP_TIMEOUT_MS - Date.now()));
startupExpiry.unref();
process.on("SIGTERM", () => { host?.terminate(); finish(143); });
process.on("SIGINT", () => { host?.terminate(); finish(130); });
try {
  host = new TerminalHost(record, platform.driver, platform.shell, code => finish(code));
  unlisten = await platform.transport.listen(directory, id, channel => host!.attach(channel));
  if (finishing || !await host.isReady() || !store.ready(id, process.pid, identity)) {
    host.terminate(); finish(1, true);
  } else {
    clearTimeout(startupExpiry);
    if (record.diagnostic) {
      // A killed diagnostic CLI must not leave a background test shell indefinitely.
      diagnosticExpiry = setTimeout(() => { host?.terminate(); finish(124); }, Math.max(1, record.createdAt + 120_000 - Date.now()));
      diagnosticExpiry.unref();
    }
  }
} catch (error) {
  console.error("[terminal] Host initialization failed:", error instanceof Error ? error.message : "Unknown error");
  host?.terminate(); finish(1, true);
}
