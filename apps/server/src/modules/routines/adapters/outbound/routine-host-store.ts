import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, writePrivateFileAtomic } from "../../../../platform/filesystem/private-files.js";
import type { RoutineScriptResult } from "../../application/ports/outbound/routines.js";

export const ROUTINE_HOST_PROTOCOL = 1;
const descriptorSchema = z.object({
  protocol: z.literal(ROUTINE_HOST_PROTOCOL), id: z.string().regex(/^[a-f0-9]+$/),
  runId: z.number().int().positive(), routineId: z.string().min(1), directory: z.string(),
  release: z.string(), node: z.string(), cwd: z.string(), worktreePath: z.string().optional(),
  script: z.object({ command: z.string().min(1), timeoutSeconds: z.number().int().positive() }),
});
export type RoutineHostDescriptor = z.infer<typeof descriptorSchema>;
const resultSchema = z.object({
  status: z.enum(["succeeded", "failed", "interrupted"]), note: z.string().optional(),
  finishedAt: z.number(), exitCode: z.number().optional(), output: z.string().optional(), worktreePath: z.string().optional(),
});

/** Retained launch and result files are independent of the web connection and database. */
export class RoutineHostStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); ensurePrivateDirectory(this.directory); }
  id(runId: number): string {
    if (!Number.isSafeInteger(runId) || runId < 1) throw new Error("Invalid routine run identity");
    return runId.toString(16);
  }
  private path(id: string, suffix = "json") {
    if (!/^[a-f0-9]+$/.test(id)) throw new Error("Invalid routine host identity");
    return join(this.directory, `${id}.${suffix}`);
  }
  create(value: RoutineHostDescriptor): void {
    const descriptor = descriptorSchema.parse(value);
    if (descriptor.id !== this.id(descriptor.runId) || descriptor.directory !== this.directory) throw new Error("Routine host identity mismatch");
    // An existing descriptor must never be replaced or reused for another invocation.
    writePrivateFileAtomic(this.path(descriptor.id), JSON.stringify(descriptor), { exclusive: true });
  }
  get(id: string): RoutineHostDescriptor | undefined {
    if (!existsSync(this.path(id))) return;
    const value = descriptorSchema.parse(JSON.parse(readFileSync(this.path(id), "utf8")));
    if (value.id !== id || value.directory !== this.directory || this.id(value.runId) !== id) throw new Error("Routine host identity mismatch");
    return value;
  }
  list(): RoutineHostDescriptor[] {
    return readdirSync(this.directory).filter(name => /^[a-f0-9]+\.json$/.test(name)).map(name => this.get(name.slice(0, -5))!);
  }
  claim(id: string): boolean {
    try { writeFileSync(this.path(id, "claim"), "claimed\n", { flag: "wx", mode: 0o600, flush: true }); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
  }
  result(id: string): RoutineScriptResult | undefined {
    if (!existsSync(this.path(id, "result"))) return;
    return resultSchema.parse(JSON.parse(readFileSync(this.path(id, "result"), "utf8")));
  }
  finish(id: string, result: RoutineScriptResult): void {
    writePrivateFileAtomic(this.path(id, "result"), JSON.stringify(resultSchema.parse(result)));
  }
  stop(id: string, reason: string): void { writePrivateFileAtomic(this.path(id, "stop"), JSON.stringify(reason)); }
  acknowledge(id: string): void { writePrivateFileAtomic(this.path(id, "recorded"), "recorded\n"); }
  recorded(id: string): boolean { return existsSync(this.path(id, "recorded")); }
  stopReason(id: string): string | undefined {
    return existsSync(this.path(id, "stop")) ? z.string().parse(JSON.parse(readFileSync(this.path(id, "stop"), "utf8"))) : undefined;
  }
}
