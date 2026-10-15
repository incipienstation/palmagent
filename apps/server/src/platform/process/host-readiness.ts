import { writePrivateFileAtomic } from "../filesystem/private-files.js";
import { processIdentity } from "./identity.js";

/** Capture the guardian's capability before spawning descendants; only this host may report ready. */
export function createHostReadiness(): () => void {
  const path = process.env.PALMAGENT_HOST_READY;
  delete process.env.PALMAGENT_HOST_READY;
  let reported = false;
  return () => {
    if (!path || reported) return; // Retained legacy/source hosts have no readiness contract.
    const start = processIdentity(process.pid);
    if (!start) throw new Error("Cannot establish host readiness identity");
    writePrivateFileAtomic(path, JSON.stringify({ pid: process.pid, start, readyAt: Date.now() }) + "\n");
    reported = true;
  };
}
