import { useEffect, useState } from "react";
import type { AccountLimits } from "@palmagent/shared";
import { useTaskOperations } from "./remote-operations";

export function useTaskAccountLimits(taskId: string) {
  const [report, setReport] = useState<AccountLimits | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  const operations = useTaskOperations(taskId);
  useEffect(() => {
    let stopped = false, pending = false;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || pending) return;
      pending = true;
      try {
        const next = await operations.accountLimits();
        if (!stopped) { setReport(next); setFailed(false); setNow(Date.now()); }
      } catch {
        if (!stopped) { setReport(null); setFailed(true); }
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 30_000);
    const visible = () => { setNow(Date.now()); void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [operations]);
  return { report, failed, now };
}
