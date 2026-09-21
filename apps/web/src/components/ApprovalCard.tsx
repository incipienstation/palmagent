import { Check, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/card";

export function ApprovalRequest({ payload, full, expanded, onToggle }: {
  payload: Record<string, unknown>; full: string; expanded: boolean; onToggle: () => void;
}) {
  const tool = typeof payload.tool === "string" ? payload.tool : typeof payload.name === "string" ? payload.name : "Requested action";
  const reason = typeof payload.reason === "string" ? payload.reason : "The agent requested permission for this action.";
  const command = typeof payload.command === "string" ? payload.command : Array.isArray(payload.command) ? payload.command.join(" ") : undefined;
  return <Card className="mb-3 min-w-0 font-sans">
    <CardHeader className="p-3 pb-2">
      <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 shrink-0 text-amber" aria-hidden />{tool}</CardTitle>
      <CardDescription className="break-words [overflow-wrap:anywhere]">{reason}</CardDescription>
    </CardHeader>
    <CardContent className="p-3 pt-0">
      {command && <pre className="overflow-x-auto rounded-lg bg-background p-2 font-mono text-xs">{command}</pre>}
      <Button variant="ghost" className="w-full justify-start px-0" aria-expanded={expanded} onClick={onToggle}>Request details</Button>
      {expanded && <pre className="max-h-48 overflow-auto text-xs break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{full}</pre>}
    </CardContent>
  </Card>;
}

// Uses the same explicit-review layout as the question card. Decisions remain
// controlled by the task action lifecycle, including retry after a failed send.
export function ApprovalCard({ busy, onDecision }: {
  busy: boolean; onDecision: (decision: "approve" | "deny") => void;
}) {
  return <Card data-approval-card aria-busy={busy}>
    <CardHeader className="p-3 pb-2">
      <CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-amber" aria-hidden />Approval needed</CardTitle>
      <CardDescription>Review the requested action in the conversation.</CardDescription>
    </CardHeader>
    <CardContent className="px-3 pb-3">
      <p role="status" className="text-xs text-muted-foreground">{busy ? "Sending your decision…" : "The agent is waiting for your decision."}</p>
    </CardContent>
    <CardFooter className="p-3 pt-0">
      <Button variant="secondary" className="flex-1" disabled={busy} onClick={() => onDecision("deny")}><X data-icon="inline-start" />Deny</Button>
      <Button className="flex-1" disabled={busy} onClick={() => onDecision("approve")}>
        {busy ? <LoaderCircle data-icon="inline-start" className="motion-safe:animate-spin" /> : <Check data-icon="inline-start" />}Approve
      </Button>
    </CardFooter>
  </Card>;
}
