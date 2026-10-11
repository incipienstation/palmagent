import { useMessageRetry } from "../message-retry";
import { Button } from "./ui/button";

export function MessageRetryStatus({ scope }: { scope: string }) {
  const pending = useMessageRetry(scope);
  if (!pending) return null;
  return <div className="flex items-center justify-between gap-2">
    <p role="status" className="text-sm text-muted-foreground">{pending.label}</p>
    <Button type="button" variant="ghost" size="sm" onClick={pending.stop}>Stop retrying</Button>
  </div>;
}
