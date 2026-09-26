import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { DispatchSessionRequest, TaskState } from "@palmagent/shared";
import type { NativeSessionOperations } from "./application/ports.js";
import { ApplicationError } from "./errors.js";
import { checkpointSession, emptyTranscriptHash, locateSession, nativeHome, processIdentity, resumeCommand, synchronizeSession } from "./native-session.js";

/** Adapts native CLI process, filesystem, and transcript operations to the application port. */
export class LocalNativeSessionAdapter implements NativeSessionOperations {
  constructor(private readonly databasePath: string) {}
  readonly emptyTranscriptHash = emptyTranscriptHash;
  home = nativeHome;
  realpath(path: string) { return realpathSync(path); }
  processIdentity = processIdentity;
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
