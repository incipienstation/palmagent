import { api } from "./api";

// Client side of Web Push. Subscribe via the registered service worker,
// then hand the subscription to the backend, which stores it and pushes on
// task completion / approval-needed. iOS requires the PWA to be installed to
// the home screen before Notification/PushManager exist at all.

export type PushStatus = "unsupported" | "denied" | "off" | "on";

function sw(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.ready;
}

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await sw();
    const sub = await reg.pushManager.getSubscription();
    return sub ? "on" : "off";
  } catch {
    return "off";
  }
}

// Permission prompts belong to the click handler, never the debounced operation.
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const { publicKey } = await api.push.key();
  const reg = await sw();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  try {
    await api.push.subscribe({ ...sub.toJSON(), endpoint: sub.endpoint });
  } catch (error) {
    await sub.unsubscribe();
    throw error;
  }
  return "on";
}

export async function disablePush(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  const reg = await sw();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    // Finish cleanup before a queued re-enable can register the same endpoint.
    await api.push.unsubscribe(sub.endpoint);
    try {
      const removed = await sub.unsubscribe();
      if (!removed && await reg.pushManager.getSubscription()) throw new Error("Push subscription is still active");
    } catch (error) {
      // Keep the prior registration when the browser refuses to unsubscribe.
      await api.push.subscribe({ ...sub.toJSON(), endpoint: sub.endpoint }).catch(() => {});
      throw error;
    }
  }
  return "off";
}

// applicationServerKey wants raw bytes; VAPID keys travel base64url-encoded.
// Built on an explicit ArrayBuffer so TS 5.7's BufferSource typing is satisfied.
function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const arr = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
