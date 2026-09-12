import { useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Copy, Terminal } from "lucide-react";
import { api } from "../api";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "./ui/sheet";
import { toast } from "./ui/toaster";

export function SessionHandoff({ task }: { task: TaskState }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const local = task.sessionControl?.owner === "local";
  const returning = task.sessionControl?.owner === "returning";
  async function prepare() {
    setBusy(true);
    try { const result = await api.handoff(task.taskId); setCommand(result.command); }
    catch (error) { toast({ title: error instanceof Error ? error.message : "Handoff failed", variant: "destructive" }); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(command); toast({ title: "Resume command copied", variant: "success" }); }
    catch { toast({ title: "Select and copy the command below", variant: "destructive" }); }
  }
  return <Sheet>
    <SheetTrigger asChild><Button variant="outline" size="sm"><Terminal data-icon="inline-start" />{returning ? "Returning from shell" : local ? "Local shell" : "Resume in shell"}</Button></SheetTrigger>
    <SheetContent className="max-h-[80dvh] overflow-y-auto">
      <SheetHeader><SheetTitle>Resume in your shell</SheetTitle><SheetDescription>Use a shell on the Palmagent host under the same account. The command opens this native session in its working directory.</SheetDescription></SheetHeader>
      <div className="flex flex-col gap-3 p-4">
        {returning ? <Alert>{task.sessionControl?.error ?? "Waiting for the local CLI to close. Palmagent will import new messages before enabling follow-up."}</Alert> : <>
          <p className="text-sm text-muted-foreground">Release this session before opening it locally. Palmagent follow-up stays paused until you use the dispatch skill in that CLI and close it. Open only one local writer.</p>
          <Button disabled={busy || !["idle", "failed"].includes(task.status)} onClick={prepare}>{local ? "Show resume command" : "Release to shell"}</Button>
          {!["idle", "failed"].includes(task.status) && <p className="text-sm">Stop the active turn and wait for it to finish first.</p>}
          {command && <><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all"><code>{command}</code></pre><Button variant="outline" onClick={copy}><Copy data-icon="inline-start" />Copy resume command</Button></>}
        </>}
      </div>
    </SheetContent>
  </Sheet>;
}
