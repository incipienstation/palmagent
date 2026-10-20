import { useId, useState } from "react";
import { useTelemetrySettings } from "../hooks/useTelemetrySettings";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import { FieldContent, FieldLabel } from "./ui/field";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { SettingsCard, SettingsField } from "./SettingsLayout";

function SharingDetails() {
  return <details className="text-xs text-muted-foreground">
    <summary className="cursor-pointer">What is shared?</summary>
    <p className="mt-2">Aggregated operation timings and outcomes, CPU and memory use, event-loop delay, and database retries.
      Metrics include the component, Node or Rust implementation, release, OS, architecture, and a coarse load bucket.
      They help compare performance as Palmagent changes.</p>
    <p className="mt-2">Sent to telemetry.palmagent.dev and retained for 7 days. No conversations, code, file paths,
      raw errors, or persistent installation IDs are sent. The service and its network provider can see connection metadata,
      including your IP address.</p>
    <p className="mt-2">This choice applies to this installation, including retained processes, and survives updates.
      Turning it off stops collection and future uploads and discards queued samples. An upload already received cannot be recalled.</p>
  </details>;
}

export function TelemetryDisclosure() {
  const { status, busy, error, request } = useTelemetrySettings();
  const [dismissed, setDismissed] = useState(false);
  return <Dialog open={!!status?.available && status.pendingDisclosure && !dismissed} onOpenChange={open => { if (!open) setDismissed(true); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Help improve Palmagent performance</DialogTitle>
        <DialogDescription>Performance sharing is on by default. No metrics are collected or uploaded until you continue.
          You can turn it off now or later in Settings.</DialogDescription>
      </DialogHeader>
      <DialogBody><SharingDetails /></DialogBody>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => void request(false)}>Turn off sharing</Button>
        <Button disabled={busy} onClick={() => void request(true)}>Continue with sharing</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function TelemetrySettings() {
  const { status, busy, error, request } = useTelemetrySettings();
  const id = useId();
  return <SettingsCard>
    <SettingsField>
      <FieldContent>
        <FieldLabel variant="setting" htmlFor={id}>Share performance metrics</FieldLabel>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {status?.pendingDisclosure ? "Sharing starts after you save your choice." : "Help improve Palmagent. Applies to this installation."}
        </p>
      </FieldContent>
      <Switch id={id} checked={status?.enabled ?? true} disabled={busy || !status?.available}
        aria-describedby={`${id}-description`} onCheckedChange={enabled => void request(enabled)} />
    </SettingsField>
    <div className="flex flex-col gap-2 p-3">
      <SharingDetails />
      {status?.pendingDisclosure && status.available &&
        <Button variant="outline" disabled={busy} onClick={() => void request(true)}>Continue with sharing</Button>}
      {status && !status.available && <p className="text-xs text-muted-foreground">Sharing is available in signed-in release installations.</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {error && <Button variant="outline" disabled={busy} onClick={() => void request()}>Retry</Button>}
    </div>
  </SettingsCard>;
}
