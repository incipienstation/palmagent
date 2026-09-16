import { z } from "zod";

const path = z.string().trim().min(1).max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value), "Path contains control characters");
export const RepoRootsSchema = z.array(path).max(64);
export const RepoSettingsChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), paths: RepoRootsSchema }).strict(),
  z.object({ action: z.literal("add"), paths: RepoRootsSchema.min(1) }).strict(),
  z.object({ action: z.literal("remove"), paths: RepoRootsSchema.min(1) }).strict(),
  z.object({ action: z.literal("reset") }).strict(),
]);
export type RepoSettingsChange = z.infer<typeof RepoSettingsChangeSchema>;
export interface RepoSettings {
  repoRoots: string[];
  defaults: string[];
  source: "saved" | "installation";
}
export type RepoSettingsStatus = RepoSettings & { writable: boolean };
