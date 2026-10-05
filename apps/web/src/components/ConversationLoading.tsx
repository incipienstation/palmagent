import { Skeleton } from "./ui/skeleton";

// Initial history has no messages to preserve. Keep its placeholder and single
// accessible announcement together; pagination keeps the existing transcript.
export function ConversationLoading() {
  return <div role="status" aria-label="Loading conversation" className="pb-6">
    <span className="sr-only">Loading conversation…</span>
    <div aria-hidden="true" className="flex flex-col gap-8 [&_[data-slot=skeleton]]:motion-reduce:animate-none">
      <Skeleton className="ml-auto h-16 w-3/4 max-w-sm rounded-2xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="ml-auto h-12 w-1/2 max-w-xs rounded-2xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  </div>;
}
