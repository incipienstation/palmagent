/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa `injectManifest` strategy). It does
// everything the old generateSW config did — precached app shell, SPA
// navigation fallback, /api runtime caching, and Web Push, which
// generateSW cannot express. Typechecked by tsconfig.sw.json (WebWorker lib),
// excluded from the app tsconfig (DOM and WebWorker globals conflict).
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst, NetworkOnly } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { BRANDING, type PushPayload } from "@palmagent/shared";

declare let self: ServiceWorkerGlobalScope;

// Prompt-to-update flow (registerType: "prompt"): a freshly deployed SW installs
// and WAITS. It activates only when the page posts SKIP_WAITING — i.e. when the
// user taps Refresh in the UpdateBanner — so a surprise reload never wipes an
// in-progress draft. clientsClaim() then lets the activated SW take control so
// the reload lands on the new version. The page-side controllerchange listener
// in pwa.ts triggers the actual reload.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});
clientsClaim();

// App shell: precache the built bundle (cache-first by content hash).
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA navigations fall back to the shell — but /api is never a navigation. Auth
// is in-app now (WebAuthn): an expired session returns 401 JSON and the app shows
// a login screen in place, so there is no external login page to route around.
registerRoute(new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api/] }));

// SSE must stream straight to the network — caching an open event-stream
// would hang the request, so never let Workbox touch it.
registerRoute(({ url }) => url.pathname.startsWith("/api/stream"), new NetworkOnly());

// Installation settings and the running version must never fall back to a stale
// offline snapshot, including when reconciling a save whose response was lost.
registerRoute(({ url }) => url.pathname === "/api/settings/updates", new NetworkOnly());

// REST: network-first so control/read calls are always fresh online, with a
// short-lived cache as an offline courtesy.
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkFirst({
    cacheName: "api",
    networkTimeoutSeconds: 10,
    plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 300 })],
  }),
);

// ---- Web Push ----
// The backend sends a JSON PushPayload; every push MUST surface a visible
// notification (browsers enforce user-visible-only).
self.addEventListener("push", (event: PushEvent) => {
  let payload: PushPayload = { title: BRANDING.displayName, body: "Task update" };
  try {
    if (event.data) payload = { ...payload, ...(event.data.json() as PushPayload) };
  } catch {
    /* non-JSON push — show the generic notification */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.taskId ?? BRANDING.packageName, // collapse repeat updates per task
      data: { url: payload.url ?? "/" },
    }),
  );
});

// Click → focus an existing app window (navigating it) or open a new one.
self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string })?.url ?? "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await (client as WindowClient).navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
