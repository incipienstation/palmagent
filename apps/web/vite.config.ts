import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// App-facing name for the browser tab + PWA manifest. Mirrors BRANDING.displayName
// (packages/shared/src/branding.ts) — it is NOT imported here because Vite loads
// this config through Node's ESM loader, which can't resolve the shared package's
// source-only `.js`→`.ts` re-export chain (the app bundle resolves it fine). Keep
// this string in sync with BRANDING.displayName on a rename (the UI brand, NOT the
// operator-facing productName which stays "Palmagent" for the CLI).
const APP_NAME = "PalmAgent";

// The backend speaks SSE (read) + REST (control) under /api on
// :4000. In dev we proxy /api -> :4000 so EventSource + fetch hit the real
// backend with same-origin URLs. Override the target with API_PROXY if needed.
const API_TARGET = process.env.API_PROXY ?? "http://localhost:4000";
const apiTargetUrl = new URL(API_TARGET);
const loopbackTarget =
  apiTargetUrl.hostname === "localhost" ||
  apiTargetUrl.hostname === "::1" ||
  /^127(?:\.\d{1,3}){3}$/.test(apiTargetUrl.hostname);
if (apiTargetUrl.protocol !== "https:" && !(apiTargetUrl.protocol === "http:" && loopbackTarget)) {
  throw new Error("API_PROXY must use HTTPS unless it targets loopback");
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      // Single-source the product name into index.html (browser tab + iOS
      // home-screen title) from BRANDING, so the brand lives in one place.
      name: "html-app-name",
      transformIndexHtml: (html: string) => html.replaceAll("__APP_NAME__", APP_NAME),
    },
    VitePWA({
      // A custom SW (src/sw.ts) replaces generateSW — Web Push handlers
      // can't be expressed in generateSW config. The SW reimplements the same
      // precache + SPA-fallback + /api caching, plus push/notificationclick.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // "prompt", not "autoUpdate": a deploy must NOT silently reload the page
      // (that wipes an in-progress dispatch/steer draft). The new SW installs
      // and waits; src/pwa.ts surfaces it as an in-app UpdateBanner and only
      // activates + reloads when the user taps Refresh.
      registerType: "prompt",
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-512-maskable.png",
      ],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: "Drive Claude Code + Codex coding agents from your phone.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#0d1117",
        theme_color: "#0d1117",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Dedicated maskable: full-bleed teal, glyph pulled into the safe zone so
          // Android's adaptive-icon crop never clips the mark.
          { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: {
        // Keep the service worker out of `vite dev` so HMR + SSE stay simple;
        // the PWA is exercised via `vite build` + `vite preview`.
        enabled: false,
      },
    }),
  ],
  server: {
    host: "localhost",
    port: 4200,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        // http-proxy streams the response body, so SSE flows through unbuffered.
      },
    },
  },
  preview: {
    host: "localhost",
  },
});
