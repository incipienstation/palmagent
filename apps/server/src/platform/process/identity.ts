import { readFileSync } from "node:fs";

// Linux process start ticks plus boot identity distinguish a live writer from
// PID reuse. Unknown inspection errors never count as a writer exit.
export function processIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("A valid local CLI process id is required");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") return undefined;
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${fields[19]}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot verify the local CLI process; ownership is retained");
  }
}
