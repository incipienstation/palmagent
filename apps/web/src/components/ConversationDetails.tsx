import type { ReactNode } from "react";
import type { ConversationContentRef, TranscriptRow } from "@palmagent/shared";
import { useConversationContent } from "../hooks/useConversationDetails";
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
