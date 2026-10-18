import { type RefObject } from "react";
import { FileText } from "lucide-react";
import type { ExecutionRecord } from "@palmagent/shared";
import { useUpdateState } from "../update-state";
import { useExecutionRecords, useExecutionRecordContent } from "../hooks/useExecutionRecords";
import { Button } from "./ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "./ui/sheet";
import { Trace, TraceLine, TraceIcon, TraceTitle, TraceCollapsible, TraceCollapsibleTrigger, TraceCollapsibleContent } from "./ui/trace";

export function ExecutionRecords({ taskId, open, onOpenChange, trigger }: {
  taskId: string; open: boolean; onOpenChange: (open: boolean) => void; trigger: RefObject<HTMLButtonElement | null>;
}) {
  return <Sheet open={open} onOpenChange={onOpenChange} direction="right">
    <SheetContent side="right" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }); }}>
      <SheetHeader><SheetTitle>Execution records</SheetTitle><SheetDescription>Recorded events, newest first.</SheetDescription></SheetHeader>
      <SheetBody>{open && <Records taskId={taskId} />}</SheetBody>
    </SheetContent>
  </Sheet>;
}

function Records({ taskId }: { taskId: string }) {
  const [expanded, setExpanded] = useUpdateState(`execution-records:${taskId}:open`, () => new Set<number>());
  const query = useExecutionRecords(taskId);
  const records = new Map(query.data?.pages.flatMap(page => page.records).map(record => [record.key, record]));
  return <div className="flex min-w-0 flex-col gap-3">
    <Button variant="outline" size="sm" className="self-start" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh records</Button>
    {query.isPending && <p role="status">Loading execution records…</p>}
    {query.isError && <div role="alert"><p>Couldn’t load execution records.</p><Button variant="outline" size="sm" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch())}>Retry</Button></div>}
    {!query.isPending && !query.isError && !records.size && <p>No execution records yet.</p>}
    <Trace>{[...records.values()].sort((a, b) => b.key - a.key).map(record => <TraceCollapsible key={record.key} open={expanded.has(record.key)} onOpenChange={next => {
      setExpanded(previous => { const keys = new Set(previous); if (next) keys.add(record.key); else keys.delete(record.key); return keys; });
    }}>
      <TraceCollapsibleTrigger aria-label={`Record ${record.key}: ${record.kind}`}>
        <TraceLine><TraceIcon><FileText /></TraceIcon><TraceTitle>#{record.key} · {record.kind}</TraceTitle></TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{expanded.has(record.key) && <RecordBody taskId={taskId} record={record} />}</TraceCollapsibleContent>
    </TraceCollapsible>)}</Trace>
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>Load earlier records</Button>}
  </div>;
}

function RecordBody({ taskId, record }: { taskId: string; record: ExecutionRecord }) {
  const query = useExecutionRecordContent(taskId, record);
  const body = record.body ?? query.data?.pages.map(page => page.chunk).join("");
  return <>
    {body !== undefined && <pre className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-foreground [overflow-wrap:anywhere]">{body}</pre>}
    {record.body === undefined && query.isPending && <p role="status">Loading record…</p>}
    {query.isError && <div role="alert"><p>Couldn’t load this record. Refresh records if it changed.</p><Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button></div>}
    {query.hasNextPage && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>Load more record content</Button>}
  </>;
}
