import { resolve } from "node:path";
import { TerminalId, TERMINAL_PROTOCOL } from "@palmagent/shared/terminals";
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
function finish(code: number, lost = false) {
  if (finishing) return;
  finishing = true;
  store.update(id, { state: "closing", exitCode: lost ? undefined : code });
  // Allow the exit frame to reach attached clients before closing IPC.
  setTimeout(() => { host?.close(); unlisten?.(); store.close(); process.exit(lost ? 1 : 0); }, 50);
}
try {
  host = new TerminalHost(record, platform.driver, platform.shell, code => finish(code));
  unlisten = await platform.transport.listen(directory, id, channel => host!.attach(channel));
  process.on("SIGTERM", () => { host?.terminate(); finish(143); });
  process.on("SIGINT", () => { host?.terminate(); finish(130); });
} catch (error) {
  console.error("[terminal] Host initialization failed:", error instanceof Error ? error.message : "Unknown error");
  host?.terminate(); finish(1, true);
}
