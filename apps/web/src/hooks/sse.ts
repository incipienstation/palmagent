import { onStreamPause, streamsPaused } from "../stream-transition";
import { probeAuth } from "../api";
import { cacheSession, onCacheSessionReset } from "../query-lifecycle";

export type ConnState = "connecting" | "open" | "reconnecting";

// A reconnecting EventSource wrapper. Mobile browsers freeze background tabs:
// the SSE socket dies but `onerror` often never fires, so EventSource's own
// auto-reconnect never kicks in and the UI silently goes stale (the inbox stops
// updating, the conn pill lies "open"). We fix that by re-dialing whenever the
// page returns to the foreground or the network comes back online.
//
// Each re-dial gets a fresh task snapshot. Scoped clients use its durable
// boundary to load any missed history from REST before applying new SSE events.
export interface SseConnection {
  reconnect: () => void;
  close: () => void;
}

export function connectSse(
  baseUrl: string,
  onMessage: (e: MessageEvent) => void,
  onConn: (s: ConnState) => void,
): SseConnection {
  let es: EventSource | null = null;
  let stopped = false;
  const generation = cacheSession();

  const open = () => {
    if (stopped || streamsPaused()) return;
    es?.close();
    onConn("connecting");
    const source = new EventSource(baseUrl);
    es = source;
    const current = () => !stopped && es === source && generation === cacheSession();
    source.onopen = () => { if (current()) onConn("open"); };
    source.onerror = () => {
      if (!current()) return;
      onConn("reconnecting");
      // A dropped session looks identical to a network blip; probe to tell them
      // apart and flip to the login screen if we're actually logged out.
      void probeAuth();
    };
    source.onmessage = (message) => { if (current()) onMessage(message); };
  };

  // Re-dial whenever the page returns to the foreground (or the network comes
  // back). Mobile can leave a dead socket reporting OPEN, so always obtain a
  // fresh snapshot and let the scoped client reconcile the REST boundary.
  const onForeground = () => {
    if (document.visibilityState === "visible") open();
  };

  const offPause = onStreamPause((paused) => {
    if (paused) { es?.close(); onConn("reconnecting"); }
    else open();
  });
  const close = () => {
    stopped = true;
    offPause();
    offSession();
    es?.close();
    document.removeEventListener("visibilitychange", onForeground);
    window.removeEventListener("online", open);
  };
  // Close immediately, before React unmounts the old session's views. Queued
  // frames and foreground events must not reconnect or refill cleared caches.
  const offSession = onCacheSessionReset(close);
  open();
  document.addEventListener("visibilitychange", onForeground);
  window.addEventListener("online", open);

  return {
    reconnect: open,
    close,
  };
}
