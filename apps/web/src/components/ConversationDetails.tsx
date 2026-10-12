import type { ReactNode } from "react";
import type { ConversationContentRef, ConversationItem, TranscriptRow } from "@palmagent/shared";
import { useConversationActivityDetails, useConversationContent } from "../hooks/useConversationDetails";
import { Button } from "./ui/button";
import { Alert } from "./ui/alert";

export function ConversationContent({ taskId, content, preview, render }: {
  taskId: string; content: ConversationContentRef; preview?: ReactNode; render: (row: TranscriptRow) => ReactNode;
}) {
  const query = useConversationContent(taskId, content);
  if (query.data) return render(query.data);
  return <div className="mb-3 flex flex-col items-start gap-2">
    {preview}
    {query.isError && <Alert role="alert">Couldn’t load the full content. Try again after the message finishes updating.</Alert>}
    <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
      {query.isFetching ? "Loading content…" : content.label}
    </Button>
  </div>;
}

export function ConversationActivityDetails({ taskId, itemKey, revision, render }: {
  taskId: string; itemKey: number; revision: number; render: (row: ConversationItem) => ReactNode;
}) {
  const query = useConversationActivityDetails(taskId, itemKey, revision);
  return <div className="pb-3">
    {query.isPending && <p role="status" className="mb-2 text-xs text-muted-foreground">Loading activity details…</p>}
    {query.items.map(item => <div key={item.key}>{render(item)}</div>)}
    {query.isError && <Alert role="alert" className="mb-2">
      <span>Couldn’t load activity details.</span>
      <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch({ cancelRefetch: false }))}>Retry</Button>
    </Alert>}
    {query.hasNextPage && !query.isError && <Button variant="outline" size="sm" disabled={query.isFetching}
      onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>
      {query.isFetchingNextPage ? "Loading activity details…" : "Load more activity"}
    </Button>}
  </div>;
}
