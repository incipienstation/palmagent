import { Brain, FileText, Wrench } from "lucide-react";
import { traceStepTitle, type Activity, type ConversationItem, type LogItem, type TraceOperation, type TraceStep } from "@palmagent/shared";
import { useUpdateState } from "../update-state";
import { useTraceSteps, useTraceStepDetails, useLegacyTraceDetails } from "../hooks/useTraceDetails";
import { activityLabel } from "../transcript";
import { Button } from "./ui/button";
import { ConversationContent } from "./ConversationDetails";
import { Markdown } from "./Markdown";
import { Trace, TraceLine, TraceIcon, TraceTitle, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent } from "./ui/trace";
import type { ReactNode } from "react";

type Props = {
  activity: Activity; running: boolean; sourceLog: LogItem[]; revision: number; taskId?: string; open: boolean; openSteps: Set<number>;
  onToggle: (activity: Activity, open: boolean) => void;
  onStepOpenChange: (key: number, open: boolean) => void;
  render: (row: ConversationItem) => ReactNode;
};

export function ActivityTrace({ activity, running: executing, sourceLog, revision, taskId, open, openSteps, onToggle, onStepOpenChange, render }: Props) {
  const query = useTraceSteps(taskId, activity.key, revision, open && !!activity.details, activity.disclosureKey);
  const [localCount, setLocalCount] = useUpdateState(`trace:${taskId}:${activity.disclosureKey ?? activity.key}:count`, 50);
  const steps = activity.details ? query.data?.pages.flatMap(page => page.steps) ?? [] : (activity.operations ?? []).slice(0, localCount);
  const running = executing && (activity.summary?.running ?? steps.find(step => step.state === "running")?.title);
  const label = activityLabel(activity, "compact");
  return <Trace data-activity className="mb-3">
    <TraceCollapsible open={open} onOpenChange={next => onToggle(activity, next)}>
      <TraceCollapsibleTrigger aria-label={running ? `${label} · Running: ${running}` : label} title={label}>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon><Wrench /></TraceIcon><TraceTitle>{running ? `Running: ${running}` : label}</TraceTitle>
        </TraceLine>
        {running && <span className="sr-only">{label}</span>}
      </TraceCollapsibleTrigger>
      {!open && activity.preview && <div data-progress-preview className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
        {activity.previewContent && taskId
          ? <ConversationContent taskId={taskId} content={activity.previewContent}
              preview={<Markdown streaming={activity.live}>{activity.preview}</Markdown>}
              render={row => row.type === "message" && row.item.kind === "assistant_text"
                ? <Markdown streaming={activity.live}>{row.item.text}</Markdown> : null} />
          : <Markdown streaming={activity.live}>{activity.preview}</Markdown>}
      </div>}
      <TraceCollapsibleContent>
        {open && <>
          {activity.details && query.isPending && <p role="status">Loading activity…</p>}
          {activity.details && query.isError && <LoadError onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch())} />}
          <Trace>
            {steps.map(source => {
              const step = !executing && source.state === "running" ? { ...source, state: "unknown" as const } : source;
              const expanded = openSteps.has(step.key);
              const Icon = step.kind === "tool" ? Wrench : step.kind === "reasoning" ? Brain : FileText;
              const title = traceStepTitle(step);
              return <TraceCollapsible key={step.key} open={expanded} onOpenChange={next => onStepOpenChange(step.key, next)}>
                <TraceCollapsibleTrigger data-trace-step={step.key} title={title} aria-label={title}>
                  <TraceLine status={step.state === "running" ? "running" : step.state === "error" ? "error" : undefined}>
                    <TraceIcon><Icon /></TraceIcon><TraceTitle>{title}</TraceTitle>
                  </TraceLine>
                </TraceCollapsibleTrigger>
                <TraceCollapsibleContent>{expanded && (activity.details && taskId
                  ? <StepDetails taskId={taskId} activityKey={activity.key} step={step} revision={revision} render={render} />
                  : <LocalStepDetails taskId={taskId} sourceLog={sourceLog} activity={activity} step={source as TraceOperation} render={render} />)}
                </TraceCollapsibleContent>
              </TraceCollapsible>;
            })}
          </Trace>
          {!activity.details && (activity.operations?.length ?? 0) > localCount && <Button variant="outline" size="sm" onClick={() => setLocalCount(count => count + 50)}>Load more steps</Button>}
          {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>Load more steps</Button>}
          {!steps.length && !query.isPending && !query.isError && <p className="text-sm">No additional steps. Other events are available in Execution records.</p>}
        </>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>;
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 text-sm"><span>Couldn’t load details.</span><Button variant="outline" size="sm" onClick={onRetry}>Retry</Button></div>;
}

function StepDetails({ taskId, activityKey, step, revision, render }: { taskId: string; activityKey: number; step: TraceStep; revision: number; render: Props["render"] }) {
  const query = useTraceStepDetails(taskId, activityKey, step.key, revision);
  const items = new Map(query.data?.pages.flatMap(page => page.items).map(item => [item.key, item]));
  return <div className="min-w-0 text-foreground">
    {query.isPending && <p role="status">Loading step details…</p>}
    {[...items.values()].map(row => <div key={row.key}>{render(row)}</div>)}
    {query.isError && <LoadError onRetry={() => void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch())} />}
    {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>Load more step details</Button>}
  </div>;
}

// Old snapshots/raw streams still use the same disclosure UI. Fetch only the
// selected operation's deferred members, never the entire Activity range.
function LocalStepDetails({ taskId, sourceLog, activity, step, render }: { taskId?: string; sourceLog: LogItem[]; activity: Activity; step: TraceOperation; render: Props["render"] }) {
  const members = sourceLog.filter(item => step.members.includes(item.key));
  const deferred = members.filter(item => item.kind !== "assistant_text" && item.detailsDeferred);
  const queries = useLegacyTraceDetails(taskId, deferred);
  const loaded = new Map<number, LogItem>(queries.flatMap(query => query.data ?? []).map(item => [item.key, item]));
  return <div className="min-w-0 text-foreground">
    {queries.some(query => query.isPending) && <p role="status">Loading step details…</p>}
    {members.filter(item => item.kind === "assistant_text" || !item.detailsDeferred || loaded.has(item.key)).map(item => <div key={item.key}>
      {render({ type: "message", key: item.key, endSeq: item.endSeq ?? item.key, revision: 0, item: loaded.get(item.key) ?? item })}
    </div>)}
    {queries.some(query => query.isError) && <LoadError onRetry={() => { for (const query of queries) if (query.isError) void query.refetch(); }} />}
  </div>;
}
