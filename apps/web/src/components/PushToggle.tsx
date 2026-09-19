import { useEffect, useId, useState } from "react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "../push";

// Push-notifications row inside the Settings sheet (its new home — the old inbox
// header pill is gone). Full-width Switch row; same on/off/blocked/unsupported
// semantics as before. Hidden when the platform can't push (e.g. vite dev — no
// SW — or an iOS Safari tab; iOS needs home-screen install).
export function PushToggle({ className }: { className?: string }) {
  const [status, setStatus] = useState<PushStatus>("unsupported");
  const [pending, setPending] = useState<"permission" | "enabling" | "disabling" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  if (status === "unsupported") return null;

  const on = status === "on";
  const blocked = status === "denied";
  const busy = pending !== null;
  const description = blocked ? "Blocked in browser settings"
    : pending === "permission" ? "Waiting for permission…"
    : pending === "enabling" ? "Enabling…"
    : pending === "disabling" ? "Disabling…"
    : error;

  async function toggle() {
    if (busy || blocked) return;
    setError(null);
    setPending(on ? "disabling" : "permission");
    try {
      const next = on ? await disablePush() : await enablePush(() => {
        setStatus("on");
        setPending("enabling");
      });
      setStatus(next);
      if (!on && next === "off") setError("Permission was not granted. Turn on to try again.");
    } catch {
      setStatus(await getPushStatus());
      setError("Could not update push notifications. Try again.");
    } finally {
      setPending(null);
    }
  }

  return (
    <label className={cn("flex min-h-[44px] items-center justify-between gap-3 py-2", className)}>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">Push notifications</span>
        <span id={descriptionId} role="status" className="text-[12.5px] text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        checked={on}
        disabled={busy || blocked}
        onCheckedChange={() => void toggle()}
        aria-label="Push notifications"
        aria-describedby={descriptionId}
        aria-busy={busy}
      />
    </label>
  );
}
