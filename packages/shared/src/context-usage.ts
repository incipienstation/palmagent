/** Latest provider-reported context size, distinct from cumulative billing usage. */
export interface ContextUsage {
  usedTokens: number;
  windowTokens: number | null;
  updatedAt: number;
  stale?: boolean;
}

export function contextRemaining(usage: ContextUsage | undefined): number | null {
  if (!usage || usage.stale || !Number.isSafeInteger(usage.usedTokens) || usage.usedTokens < 0 ||
      !Number.isSafeInteger(usage.windowTokens) || usage.windowTokens! <= 0) return null;
  return Math.max(0, Math.min(100, (1 - usage.usedTokens / usage.windowTokens!) * 100));
}
