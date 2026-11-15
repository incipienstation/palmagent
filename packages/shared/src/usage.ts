import { z } from "zod";
import type { UsageResponse } from "./protocol.js";

// Legacy totals can overflow after summing finite observations. JSON encodes them as
// null; restore Infinity internally so a retained HTTP caller re-encodes the same wire value.
const total = z.number().nonnegative().nullable().transform(value => value ?? Infinity);
export const UsageResponseSchema: z.ZodType<UsageResponse> = z.object({ usage: z.array(z.object({
  agent: z.enum(["claude", "codex"]), taskCount: z.number().int().nonnegative(), turnCount: z.number().int().nonnegative(),
  totalCostUsd: total, durationMs: total, inputTokens: total, cachedInputTokens: total,
  outputTokens: total, reasoningOutputTokens: total,
  reported: z.array(z.enum(["totalCostUsd", "durationMs", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"])).optional(),
})) });
