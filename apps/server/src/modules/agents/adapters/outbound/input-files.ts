import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_MEDIA_TYPE, FileMetadataSchema, INPUT_FILE_POLICY, type InputAttachment } from "@palmagent/shared";
import { writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { AgentRunner, ProcessBackend } from "../../application/ports/outbound/provider-process.js";
import type { Emit, StartArgs } from "../../domain/execution.js";
import type { RunHandle } from "../../domain/run-handle.js";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Stage on the execution host, where provider tools can read the original bytes.
 * Stable task directories survive daemon reattachment; nothing is sent again.
 * Copies live until the provider exits, while durable originals stay in Tasks.
 */
export function startWithInputFiles(runner: AgentRunner, args: StartArgs, emit: Emit, backend: ProcessBackend): RunHandle {
  const root = join(tmpdir(), `palmagent-input-${process.getuid?.() ?? "user"}`);
  const directory = join(root, hash(`${args.cwd}\0${args.taskId}`));
  const privateDirectory = (path: string) => {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe attachment staging directory");
  };
  const prepare = (text: string, attachments?: InputAttachment[]) => {
    const images: InputAttachment[] = [], notes: string[] = [];
    for (const attachment of attachments ?? []) {
      if (!attachment.file) { images.push(attachment); continue; }
      const { name } = FileMetadataSchema.parse(attachment.file);
      if (attachment.mediaType !== FILE_MEDIA_TYPE || attachment.data.length > Math.ceil(INPUT_FILE_POLICY.maxBytes / 3) * 4) throw new Error("Invalid file attachment");
      const bytes = Buffer.from(attachment.data, "base64");
      if (bytes.length > INPUT_FILE_POLICY.maxBytes || bytes.toString("base64") !== attachment.data) throw new Error("Invalid file attachment");
      privateDirectory(root); privateDirectory(directory);
      const folder = join(directory, hash(bytes));
      privateDirectory(folder);
      const path = join(folder, name);
      // Keep the atomic writer's temporary suffix off the user filename: a
      // valid 255-byte basename may already fill the filesystem component limit.
      const staged = join(folder, ".upload");
      writePrivateFileAtomic(staged, bytes);
      renameSync(staged, path);
      notes.push(`File attachment ${JSON.stringify(name)} (${bytes.length} bytes): ${JSON.stringify(path)}`);
    }
    return { text: [text, ...(notes.length ? ["Attached files are available at these local paths for this turn. Read them with your tools as needed.", ...notes] : [])].filter(Boolean).join("\n\n"), images };
  };
  let finished = false;
  const cleanup = () => {
    finished = true;
    try {
      for (const path of [root, directory]) {
        const stat = lstatSync(path);
        if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) return;
      }
      rmSync(directory, { recursive: true, force: true });
    } catch { /* Cleanup must not change a confirmed provider result. */ }
  };
  let attached = !args.reattach;
  const transport: ProcessBackend = {
    start: spec => backend.start(spec),
    attach: (id, sequence) => {
      const proc = backend.attach(id, sequence);
      attached = !!proc;
      return proc;
    },
  };
  let input: ReturnType<typeof prepare> | undefined;
  try { input = args.reattach ? undefined : prepare(args.prompt, args.images); }
  catch (error) { cleanup(); throw error; }
  // A launch exception can be uncertain too: the provider may already exist.
  const handle = runner.start(input ? { ...args, prompt: input.text, images: input.images } : args, emit, transport);
  return {
    ...handle,
    ...(handle.send ? { send: (text, images, messageId, skills) => {
      if (finished) return Promise.resolve("rejected" as const);
      let input: ReturnType<typeof prepare>;
      try { input = prepare(text, images); }
      catch { return Promise.resolve("rejected" as const); }
      return handle.send!(input.text, input.images, messageId, skills);
    } } : {}),
    steer: (text, images) => {
      if (finished) return false;
      let input: ReturnType<typeof prepare>;
      try { input = prepare(text, images); } catch { return false; }
      return handle.steer(input.text, input.images);
    },
    done: handle.done.finally(() => {
      finished = true;
      // Failed reattachment does not establish that the provider has exited.
      if (attached) cleanup();
    }),
  };
}
