import { toast } from "./components/ui/toaster";
import { disablePush, enablePush, getPushStatus, type PushStatus } from "./push";
import { beginBrowserWork } from "./update-state";

// This device's pending preference survives closing and reopening Settings.
// Only one subscription operation runs at a time; newer clicks replace its target.
let confirmed: PushStatus = "unsupported";
let desired = false;
let revision = 0;
let running = false;
let requestingPermission = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let finishWork: (() => void) | undefined;
let snapshot = { status: confirmed as PushStatus, checked: false, pending: false, requestingPermission: false };
const listeners = new Set<() => void>();

export const getPushPreference = () => snapshot;
export function subscribePushPreference(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish() {
  const pending = running || requestingPermission || timer !== undefined;
  snapshot = { status: confirmed, checked: requestingPermission ? confirmed === "on" : desired, pending, requestingPermission };
  listeners.forEach((listener) => listener());
  if (!pending) { finishWork?.(); finishWork = undefined; }
}

export async function refreshPushPreference() {
  if (snapshot.pending) return;
  const atRevision = revision;
  const status = await getPushStatus();
  if (atRevision !== revision || snapshot.pending) return;
  confirmed = status;
  desired = status === "on";
  publish();
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void flush(); }, 250);
  publish();
}

async function flush() {
  if (running || requestingPermission || timer !== undefined) return;
  running = true;
  const atRevision = revision;
  const target = desired;
  try {
    if (target !== (confirmed === "on")) {
      confirmed = target ? await enablePush() : await disablePush();
      if (target && confirmed !== "on") throw new Error("Notification permission was not granted");
    }
  } catch {
    confirmed = await getPushStatus();
    // An obsolete failure must neither roll back a later click nor show its toast.
    if (atRevision === revision) {
      desired = confirmed === "on";
      toast({
        title: confirmed === "denied"
          ? "Notifications are blocked. Allow them in browser settings."
          : "Could not update push notifications. Try again.",
        variant: "destructive",
      });
    }
  } finally {
    running = false;
    if (atRevision !== revision && timer === undefined && !requestingPermission) void flush();
    else publish();
  }
}

async function requestPermission() {
  try {
    // Called synchronously from the click, before any debounce or await.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      confirmed = permission === "denied" ? "denied" : "off";
      desired = false;
      revision++;
      toast({
        title: permission === "denied"
          ? "Notifications are blocked. Allow them in browser settings."
          : "Notification permission was not granted. Try again.",
        variant: "destructive",
      });
    }
  } catch {
    desired = confirmed === "on";
    revision++;
    toast({ title: "Could not request notification permission. Try again.", variant: "destructive" });
  } finally {
    requestingPermission = false;
    schedule();
  }
}

export function setPushPreference(checked: boolean) {
  if (confirmed === "unsupported" || requestingPermission) return;
  desired = checked;
  revision++;
  finishWork ??= beginBrowserWork();
  if (checked && Notification.permission === "default") {
    clearTimeout(timer);
    timer = undefined;
    requestingPermission = true;
    publish();
    void requestPermission();
  } else {
    schedule();
  }
}
