import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import brand from "./src/brand.json";

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
  define: { __PALMAGENT_WEB_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version) },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The browser export uses document.createElement. Use the equivalent
      // entity-table decoder in both dev and build, including Markdown workers.
      "decode-named-character-reference": createRequire(import.meta.url).resolve("decode-named-character-reference"),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      // Single-source the product name into index.html (browser tab + iOS
      // home-screen title) from BRANDING, so the brand lives in one place.
      name: "html-brand",
      // Render before the bootstrap and first paint; CSS, browser chrome and
      // standalone assets all consume the same palette without runtime fetching.
      transformIndexHtml: {
        order: "pre",
        handler: (html: string) => html
        .replaceAll("__APP_NAME__", APP_NAME)
        .replaceAll("__BRAND_LIGHT_CHROME__", brand.light.chrome)
        .replaceAll("__BRAND_DARK_CHROME__", brand.dark.chrome)
        .replace("__BRAND_STYLES__", Object.entries(brand).map(([theme, tokens]) =>
          `${theme === "light" ? ":root" : ".dark"} { ${Object.entries(tokens)
            .map(([name, value]) => `--brand-${name}: ${value};`).join(" ")} }`,
        ).join("\n")),
      },
    },
    VitePWA({
      // A custom SW (src/sw.ts) replaces generateSW — Web Push handlers
      // can't be expressed in generateSW config. The SW reimplements the same
      // precache + SPA-fallback, plus push/notificationclick.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // The page checkpoints drafts before sending SKIP_WAITING. Registration
      // stays page-owned so no generated listener can reload a tab prematurely.
      registerType: "prompt",
      injectRegister: false,
      includeAssets: [
        "favicon.svg",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "icon-512-maskable.png",
        "notification-badge.png",
      ],
      manifest: {
        name: APP_NAME,
        short_name: APP_NAME,
        description: "Drive Claude Code + Codex coding agents from your phone.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: brand.light.chrome,
        theme_color: brand.light.chrome,
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          // Dedicated maskable: full-bleed brand color, glyph pulled into the safe zone so
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
