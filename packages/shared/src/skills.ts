import { z } from "zod";

// A reference to an explicit user choice, never executable skill content.
export const SkillSelectionSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().min(1).max(200),
  source: z.string().max(200), pluginId: z.string().max(200).optional(),
  path: z.string().max(4096).optional(),
});
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
// One invocation per message preserves Claude's slash-command argument semantics.
export const SelectedSkillsSchema = z.array(SkillSelectionSchema).max(1).optional();
export interface AvailableSkill extends SkillSelection { description: string }
export interface SkillCatalog { skills: AvailableSkill[]; warning?: string }
export const SkillContextSchema = z.object({
  taskId: z.string().min(1).optional(), repoId: z.string().min(1).optional(),
  agent: z.enum(["claude", "codex"]).optional(),
}).refine(v => v.taskId ? !v.repoId && !v.agent : !!v.repoId && !!v.agent, "Select a task or a repository and agent");
export type SkillContext = z.infer<typeof SkillContextSchema>;
