/// <reference lib="webworker" />
// Custom service worker (vite-plugin-pwa `injectManifest` strategy). It does
// everything the old generateSW config did — precached app shell, SPA
// navigation fallback and Web Push, which
// generateSW cannot express. Typechecked by tsconfig.sw.json (WebWorker lib),
// excluded from the app tsconfig (DOM and WebWorker globals conflict).
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { BRANDING, type PushPayload } from "@palmagent/shared";

declare let self: ServiceWorkerGlobalScope;
declare const __PALMAGENT_WEB_VERSION__: string;

// The page automatically sends SKIP_WAITING after checkpointing its state.
// Every tab handles controllerchange independently, preserving its own draft
// before reloading; activating a worker never controls agent execution.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | undefined)?.type === "PALMAGENT_VERSION") {
    event.ports[0]?.postMessage({ version: __PALMAGENT_WEB_VERSION__ });
  }
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

// Leave SSE fetches unhandled. Even NetworkOnly ties an open stream to the
// active worker and can keep a waiting worker from completing activation.

// API responses belong to the current authenticated session. Leave them
// unhandled (including SSE); explicit page-local caching owns safe read reuse.
// Retire the old shared offline cache when upgrading an existing installation.
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete("api"));
});

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
      // Android uses the alpha silhouette here; an app-icon background becomes a solid square.
      badge: "/notification-badge.png",
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
