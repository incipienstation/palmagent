import { probeAuth } from "../api";

export type ConnState = "connecting" | "open" | "reconnecting";

// A reconnecting EventSource wrapper. Mobile browsers freeze background tabs:
// the SSE socket dies but `onerror` often never fires, so EventSource's own
// auto-reconnect never kicks in and the UI silently goes stale (the inbox stops
// updating, the conn pill lies "open"). We fix that by re-dialing whenever the
// page returns to the foreground or the network comes back online.
//
// Each re-dial passes the last seen event id as `?lastEventId=` so the server
// replays only what was missed (cheap) — and it always resends a fresh `tasks`
// snapshot on connect, which is what resyncs the inbox/detail after a gap. The
// server prefers the Last-Event-ID *header* (used by EventSource's own native
// reconnect) over the query param, so the two reconnect paths don't conflict.
export function connectSse(
  baseUrl: string,
  onMessage: (e: MessageEvent) => void,
  onConn: (s: ConnState) => void,
  getLastId: () => string | number | undefined,
): () => void {
  let es: EventSource | null = null;
  let stopped = false;

  const open = () => {
    if (stopped) return;
    es?.close();
    onConn("connecting");
    const lastId = getLastId();
    const url = lastId
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(String(lastId))}`
      : baseUrl;
    es = new EventSource(url);
    es.onopen = () => onConn("open");
    es.onerror = () => {
      onConn("reconnecting");
      // A dropped session looks identical to a network blip; probe to tell them
      // apart and flip to the login screen if we're actually logged out.
      void probeAuth();
    };
    es.onmessage = onMessage;
  };

  // Re-dial whenever the page returns to the foreground (or the network comes
  // back). We can't trust readyState here: mobile often leaves a dead socket
  // reporting OPEN, so a guard would skip exactly the stale case we're fixing.
  // The re-dial is cheap — a fresh `tasks` snapshot plus replay only past the
  // last event id — so unconditionally reconnecting on foreground is the safe call.
  const onForeground = () => {
    if (document.visibilityState === "visible") open();
  };

  open();
  document.addEventListener("visibilitychange", onForeground);
  window.addEventListener("online", open);

  return () => {
    stopped = true;
    es?.close();
    document.removeEventListener("visibilitychange", onForeground);
    window.removeEventListener("online", open);
  };
}
