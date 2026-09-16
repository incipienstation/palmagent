import { useEffect, useRef, useState } from "react";
import type { TaskState } from "@palmagent/shared";
import { Copy, Terminal } from "lucide-react";
import { api } from "../api";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { toast } from "./ui/toaster";

export function SessionHandoff({ task }: { task: TaskState }) {
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const commandRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (command) commandRef.current?.scrollIntoView({ block: "nearest" });
  }, [command]);
  const local = task.sessionControl?.owner === "local";
  const returning = task.sessionControl?.owner === "returning";
  useEffect(() => {
    if (task.sessionControl?.owner !== "local") setCommand("");
  }, [task.taskId, task.sessionControl?.owner]);
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
  return <section aria-label="Shell handoff" className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Terminal aria-hidden className="size-4" />{returning ? "Continue in Palmagent" : "Resume in your shell"}</h3>
      <p className="text-sm text-muted-foreground">{returning ? "Saved messages are visible here while your local CLI keeps control. Close that CLI normally to enable follow-up after synchronization." : "Use a shell on the Palmagent host under the same account. The command opens this native session in its working directory."}</p>
      <div className="flex flex-col gap-3">
        {returning ? <Alert>{task.sessionControl?.error ?? "You can keep the local CLI open for read-only viewing. To continue here, close it and wait for synchronization to finish."}</Alert> : <>
          <p className="text-sm text-muted-foreground">Release this session before opening it locally. Palmagent follow-up stays paused until you use the dispatch skill in that CLI and close it. Open only one local writer.</p>
          <Button disabled={busy || !["idle", "failed"].includes(task.status)} onClick={prepare}>{local ? "Show resume command" : "Release to shell"}</Button>
          {!["idle", "failed"].includes(task.status) && <p className="text-sm">Stop the active turn and wait for it to finish first.</p>}
          {command && <div ref={commandRef} className="flex flex-col gap-3"><pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-all"><code>{command}</code></pre><Button variant="outline" onClick={copy}><Copy data-icon="inline-start" />Copy resume command</Button></div>}
        </>}
      </div>
  </section>;
}
