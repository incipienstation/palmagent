import { useEffect, useId, useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { getPushPreference, refreshPushPreference, setPushPreference, subscribePushPreference } from "../push-preference";

// Device notification preference; unsupported platforms do not show this row.
export function PushToggle({ className }: { className?: string }) {
  const { status, checked, pending, requestingPermission } = useSyncExternalStore(subscribePushPreference, getPushPreference);
  const descriptionId = useId();

  useEffect(() => {
    void refreshPushPreference();
  }, []);

  if (status === "unsupported") return null;

  const description = requestingPermission ? "Waiting for permission…"
    : status === "denied" ? "Blocked in browser settings" : null;

  return (
    <label className={cn("flex min-h-[44px] items-center justify-between gap-3 py-2", className)}>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium text-foreground">Push notifications</span>
        <span id={descriptionId} role="status" className="text-[12.5px] text-muted-foreground">
          {description}
        </span>
      </span>
      <Switch
        checked={checked}
        disabled={requestingPermission}
        onCheckedChange={setPushPreference}
        aria-label="Push notifications"
        aria-describedby={descriptionId}
        aria-busy={pending}
      />
    </label>
  );
}
