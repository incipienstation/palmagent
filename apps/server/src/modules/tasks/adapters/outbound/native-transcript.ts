import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import type { TaskState } from "@palmagent/shared";

type RecordValue = Record<string, any>;
type Checkpoint = { cursor: number; prefixHash: string };
const changed = () => new Error("Native transcript changed before the synchronization cursor");

/** Scan a fixed file snapshot with one JSONL record in memory, not the entire history.
 * Previously imported bytes are still hashed to detect rewrites, but only identity
 * metadata and appended records are parsed. An unfinished preview never advances.
 */
export function scanTranscript(path: string, task: TaskState, previous: Checkpoint | undefined,
  preview: boolean, consume: (row: RecordValue) => void): Checkpoint {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Native transcript is not a regular file");
    const from = previous?.cursor ?? 0;
    if (!Number.isSafeInteger(from) || from < 0 || stat.size < from) throw changed();
    const hash = createHash("sha256");
    let verified = !previous || from === 0 && previous.prefixHash === hash.copy().digest("hex");
    let identity: RecordValue | undefined;
    let identityError: unknown;
    let cursor = 0, position = 0, length = 0;
    let parts: Buffer[] = [];
    const accept = () => {
      for (const part of parts) hash.update(part);
      cursor += length;
      if (previous && !verified && cursor >= from) {
        if (cursor !== from || hash.copy().digest("hex") !== previous.prefixHash) throw changed();
        verified = true;
      }
      if (!identity || cursor > from) {
        const text = Buffer.concat(parts, length).toString("utf8").trim();
        if (text) {
          try {
            const row = JSON.parse(text) as RecordValue;
            identity ??= task.agent === "codex" ? row.type === "session_meta" ? row.payload : undefined
              : row.sessionId === task.sessionId && row.cwd ? row : undefined;
            if (cursor > from) consume(row);
          } catch (error) {
            if (cursor > from) throw error;
            identityError ??= error;
          }
        }
      }
      parts = []; length = 0;
    };
    while (position < stat.size) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stat.size - position));
      const count = readSync(fd, chunk, 0, chunk.length, position);
      if (!count) throw changed();
      position += count;
      let start = 0;
      while (start < count) {
        const newline = chunk.indexOf(10, start);
        const end = newline >= 0 && newline < count ? newline + 1 : count;
        const part = chunk.subarray(start, end);
        parts.push(part); length += part.length;
        if (newline >= 0 && newline < count) accept();
        start = end;
      }
    }
    if (!verified) throw changed();
    if (identityError) throw identityError;
    if (length && !preview) throw new Error("Native transcript has an unfinished record; try again after the CLI closes");
    if (!(preview && cursor === 0) && (!identity ||
      (task.agent === "codex" ? identity.id : identity.sessionId) !== task.sessionId ||
      realpathSync(identity.cwd) !== realpathSync(task.worktreePath!))) {
      throw new Error("Native session identity or working directory does not match");
    }
    return { cursor, prefixHash: hash.digest("hex") };
  } finally { closeSync(fd); }
}
