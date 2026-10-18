import { readFileSync, realpathSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DispatchSessionRequest, TaskState } from "@palmagent/shared";
import type { NativeSessionOperations } from "../../application/ports/outbound/native-session.js";
import { ApplicationError } from "../../../../kernel/errors.js";
import { checkpointSession, emptyTranscriptHash, locateSession, nativeHome, processIdentity, resumeCommand, synchronizeSession } from "./native-session.js";

/** Adapts native CLI process, filesystem, and transcript operations to the application port. */
export class LocalNativeSessionAdapter implements NativeSessionOperations {
  constructor(private readonly databasePath: string) {}
  readonly emptyTranscriptHash = emptyTranscriptHash;
  home = nativeHome;
  realpath(path: string) { return realpathSync(path); }
  processIdentity = processIdentity;
  sharedSocket(task: TaskState): string | undefined {
    const control = task.sessionControl;
    if (task.agent !== "codex" || !control?.waitPid || !control.waitIdentity || processIdentity(control.waitPid) !== control.waitIdentity) return;
    const argv = readFileSync(`/proc/${control.waitPid}/cmdline`, "utf8").split("\0");
    if (!argv.includes("app-server")) return;
    // Resolve the listener from the registered native process, not another
    // daemon that happens to use the same provider home.
    const inodes = new Set<string>();
    for (const fd of readdirSync(`/proc/${control.waitPid}/fd`)) {
      try {
        const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${control.waitPid}/fd/${fd}`));
        if (match) inodes.add(match[1]);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const sockets = readFileSync("/proc/net/unix", "utf8").split("\n").flatMap(line => {
      const fields = line.trim().split(/\s+/);
      return fields[3] === "00010000" && fields[4] === "0001" && inodes.has(fields[6]) && fields[7]?.startsWith("/") ? [fields.slice(7).join(" ")] : [];
    });
    if (sockets.length !== 1) return;
    const socket = realpathSync(sockets[0]), stat = statSync(socket);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("The native session socket must belong to this account");
    if (processIdentity(control.waitPid) !== control.waitIdentity) return;
    return socket;
  }
  checkpoint = checkpointSession;
  synchronize = synchronizeSession;

  resumeCommand(task: TaskState) {
    return resumeCommand(task, dirname(this.databasePath));
  }

  resolveDispatch(request: DispatchSessionRequest, expectedHome: string) {
    const home = realpathSync(request.home);
    if (home !== realpathSync(expectedHome)) {
      throw new ApplicationError("conflict", "The local CLI and Palmagent must use the same provider home");
    }
    const identity = processIdentity(request.waitPid);
    if (!identity) throw new ApplicationError("conflict", "The local CLI must still be running when requesting dispatch");
    const argv = readFileSync(`/proc/${request.waitPid}/cmdline`, "utf8").split("\0");
    if (!argv.slice(0, 2).some((arg) => basename(arg) === request.agent || basename(arg) === `${request.agent}.js`)) {
      throw new ApplicationError("bad_request", "waitPid must identify the native agent CLI");
    }
    const cwd = realpathSync(request.cwd);
    const transcript = locateSession(request.agent, request.sessionId, cwd, home);
    return { cwd, home, transcript, identity };
  }
}
