import { useEffect, useId, useSyncExternalStore } from "react";

import { FieldContent, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { SettingsField } from "./SettingsLayout";
import { Switch } from "@/components/ui/switch";
import { getPushPreference, refreshPushPreference, setPushPreference, subscribePushPreference } from "../push-preference";

// Device notification preference; unsupported platforms do not show this row.
export function PushToggle() {
  const { status, checked, pending, requestingPermission } = useSyncExternalStore(subscribePushPreference, getPushPreference);
  const id = useId();
  const descriptionId = `${id}-description`;

  useEffect(() => {
    void refreshPushPreference();
  }, []);

  if (status === "unsupported") return null;

  const description = requestingPermission ? "Waiting for permission…"
    : status === "denied" ? "Blocked in browser settings" : null;

  return (
    <>
      <Separator />
      <SettingsField>
        <FieldContent>
          <FieldLabel variant="setting" htmlFor={id}>Push notifications</FieldLabel>
          {description && <p id={descriptionId} role="status" className="text-xs text-muted-foreground">{description}</p>}
        </FieldContent>
        <Switch
          id={id}
          checked={checked}
          disabled={requestingPermission}
          onCheckedChange={setPushPreference}
          aria-label="Push notifications"
          aria-describedby={description ? descriptionId : undefined}
          aria-busy={pending}
        />
      </SettingsField>
    </>
  );
}
