import type { UpdateDiscoveryFailure } from "@palmagent/shared/updates";
import type { RunResult } from "./sh.js";

export class UpdateDiscoveryError extends Error {
  constructor(readonly failure: UpdateDiscoveryFailure, message: string) { super(message); }
}

/** Keep existing typed failures; replace arbitrary parser/filesystem errors with
 * a public category instead of carrying their private input into diagnostics. */
export function discoveryStep<T>(failure: UpdateDiscoveryFailure, message: string, read: () => T): T {
  try { return read(); }
  catch (error) {
    if (error instanceof UpdateDiscoveryError) throw error;
    throw new UpdateDiscoveryError(failure, message);
  }
}

export function discoveryCommandFailure(source: UpdateDiscoveryFailure["source"], result: RunResult): UpdateDiscoveryFailure {
  const spawnCodes: Record<string, UpdateDiscoveryFailure["code"]> = {
    ENOENT: "command-not-found", EACCES: "permission-denied", EPERM: "permission-denied",
    ETIMEDOUT: "timeout", ENOBUFS: "output-limit",
  };
  let code = spawnCodes[result.errorCode ?? ""] ?? "command-failed";
  if (!result.errorCode && source === "registry") {
    // npm's stderr can contain credentials and private registry URLs. Extract
    // only a known error code, never persist the text or an arbitrary match.
    const npmCode = /(?:npm (?:ERR!|error) code)\s+([A-Z0-9_]+)/.exec(result.stderr)?.[1];
    if (npmCode && ["EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "FETCH_ERROR"].includes(npmCode)) code = "network";
    else if (npmCode === "E401" || npmCode === "E403") code = "registry-auth";
    else if (npmCode === "E404" || npmCode === "ETARGET") code = "release-unavailable";
    else if (npmCode === "EACCES" || npmCode === "EPERM") code = "permission-denied";
  }
  return { source, code, exitCode: result.code };
}
