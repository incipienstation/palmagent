// Account quotas are independent of a task's token/cost reports. Keep the
// providers' different bucket structures; timestamps on this wire are epoch ms.
export interface LimitWindow {
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface CodexLimitBucket {
  id: string;
  name: string;
  primary?: LimitWindow & { windowMinutes: number | null };
  secondary?: LimitWindow & { windowMinutes: number | null };
  credits?: { unlimited: boolean; balance: string | null };
}

interface LimitReport {
  checkedAt: number;
  state: "ready" | "unavailable" | "error";
}

export interface ClaudeAccountLimits extends LimitReport {
  agent: "claude";
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  modelLimits: Array<{ name: string; window: LimitWindow }>;
  extraUsage?: { usedPercent: number | null };
}

export interface CodexAccountLimits extends LimitReport {
  agent: "codex";
  buckets: CodexLimitBucket[];
}

export type AccountLimits = ClaudeAccountLimits | CodexAccountLimits;
