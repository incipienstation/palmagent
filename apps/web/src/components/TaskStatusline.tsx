import { useOutputMode } from "../OutputModeProvider";
import { Disclosure } from "./Disclosure";
import { Badge } from "@/components/ui/badge";
import type { LogItem } from "../hooks/useTaskStream";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat("en");

// Use the latest result, including an empty one: retaining older numbers would
// falsely attribute a previous turn's usage to a newer, unreported turn. Do not
// sum reports: the adapters can report different scopes for tokens and cost.
export function TaskStatusline({ log, running, detailed = false }: { log: LogItem[]; running: boolean; detailed?: boolean }) {
  const { mode } = useOutputMode();
  let latest: LogItem | undefined;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === "result") { latest = log[i]; break; }
  }
  const payload = latest && latest.kind !== "assistant_text" ? record(latest.event.payload) : {};
  const usage = record(payload.usage);
  const metrics: Array<{ label: string; value: number }> = [];
  for (const [label, field] of [
    ["Input", "input_tokens"],
    ["Output", "output_tokens"],
    ["Cache read", latest && latest.kind !== "assistant_text" && latest.event.agent === "claude"
      ? "cache_read_input_tokens" : "cached_input_tokens"],
    ["Cache write", "cache_creation_input_tokens"],
    ["Reasoning", "reasoning_output_tokens"],
  ]) {
    const value = number(usage[field]);
    if (value !== undefined) metrics.push({ label, value });
  }
  const cost = number(payload.total_cost_usd);
  const reported = metrics.length > 0 || cost !== undefined;

  const detail = (
    <section aria-label="Task usage" className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span>Usage · latest report</span>
      <div role="status" className="flex flex-wrap items-center gap-1.5">
        {metrics.map(({ label, value }, i) => (
          <Badge key={`${label}-${i}`} variant="secondary" title={`${label}: ${exact.format(value)} tokens`}>
            {label} {tokens.format(value)}
          </Badge>
        ))}
        {cost !== undefined && <Badge variant="outline">Reported cost ${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}</Badge>}
        {!reported && <span>{running ? "Waiting for usage report…" : "Usage not reported"}</span>}
      </div>
      {running && reported && <span>Current turn usage arrives when the turn finishes.</span>}
    </section>
  );
  if (detailed || mode === "verbose") return detail;
  if (mode === "compact" || !reported) return null;
  const summary = metrics.filter(({ label }) => label === "Input" || label === "Output")
    .map(({ label, value }) => `${label === "Input" ? "in" : "out"} ${tokens.format(value)}`);
  if (cost !== undefined) summary.push(`$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`);
  if (!summary.length) summary.push("details");
  return <Disclosure label={`Latest usage · ${summary.join(" · ")}`}>{detail}</Disclosure>;
}
