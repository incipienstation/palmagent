import { useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "../push";

// Push-notifications row inside the Settings sheet (its new home — the old inbox
// header pill is gone). Full-width Switch row; same on/off/blocked/unsupported
// semantics as before. Hidden when the platform can't push (e.g. vite dev — no
// SW — or an iOS Safari tab; iOS needs home-screen install).
export function PushToggle() {
  const [status, setStatus] = useState<PushStatus>("unsupported");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  if (status === "unsupported") return null;

  const on = status === "on";
  const blocked = status === "denied";

  async function toggle() {
    if (busy || blocked) return;
    setBusy(true);
    try {
      setStatus(on ? await disablePush() : await enablePush());
    } catch {
      setStatus(await getPushStatus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="flex min-h-[44px] items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 flex-col">
        <span className="text-[15px] text-foreground">Push notifications</span>
        {blocked && (
          <span className="text-[12.5px] text-muted-foreground">Blocked in browser settings</span>
        )}
      </span>
      <Switch
        checked={on}
        disabled={busy || blocked}
        onCheckedChange={() => void toggle()}
        aria-label="Push notifications"
      />
    </label>
  );
}
