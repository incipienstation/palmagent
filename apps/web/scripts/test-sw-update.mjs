#!/usr/bin/env node
/**
 * Standalone smoke-test: UpdateBanner Refresh button with a REAL service worker.
 * The regular Playwright harness can't cover this because it uses a mock backend
 * with no real SW lifecycle (install → wait → skip → reload).
 *
 * Prerequisites: pnpm --filter @palmagent/web build
 *
 * Run from repo root:
 *   node apps/web/scripts/test-sw-update.mjs
 */

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL("..", import.meta.url));
const SW_PATH = join(WEB_DIR, "dist", "sw.js");
const PORT = 4398; // separate port — no conflict with normal e2e on 4317
const BASE = `http://localhost:${PORT}`;

let originalSw = null;
let server = null;

// ---- cleanup ----------------------------------------------------------
async function cleanup() {
  try {
    if (originalSw !== null) {
      await writeFile(SW_PATH, originalSw);
      console.log("[test] restored sw.js");
    }
  } finally {
    // A failed restore must fail the gate: packaging reuses these verified bytes.
    if (server) server.kill("SIGTERM");
  }
}

process.on("SIGINT", () => cleanup().then(() => process.exit(1)));
process.on("uncaughtException", (e) => {
  console.error("[test] uncaught:", e);
  cleanup().then(() => process.exit(1));
});

// ---- start mock server -------------------------------------------------
function startMockServer() {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(WEB_DIR, "tests/mock-server.mjs")], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => {
      const line = d.toString();
      process.stdout.write(`[mock] ${line}`);
      if (line.includes(`${PORT}`)) resolve(child); // ready when it logs the port
    });
    child.stderr.on("data", (d) => process.stderr.write(`[mock] ${d}`));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`mock-server exited ${code}`));
    });
    setTimeout(() => reject(new Error("mock-server startup timeout")), 10_000);
  });
}

async function waitForHealth(url, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`health check timeout: ${url}`);
}

// ---- test -------------------------------------------------------------
async function run() {
  // Preserve original sw.js before any mutation
  originalSw = await readFile(SW_PATH, "utf8");

  console.log("[test] starting mock server on port", PORT);
  server = await startMockServer();
  await waitForHealth(BASE);
  console.log("[test] mock server healthy");

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  let passed = false;
  try {
    // ---- Phase 1: fresh context, SW installs and activates on first load ----
    console.log("\n[test] Phase 1 — first load, wait for SW to activate...");
    const ctx = await browser.newContext({ baseURL: BASE });

    // Forward browser console so we can see workbox logs
    const page = await ctx.newPage();
    page.on("console", (m) => {
      console.log(`  [browser:${m.type()}] ${m.text()}`);
    });

    await page.goto("/");

    // Wait until the SW is both active AND controlling the page
    await page.waitForFunction(
      () =>
        navigator.serviceWorker.ready.then(
          () => new Promise((res) => {
            if (navigator.serviceWorker.controller) return res(true);
            navigator.serviceWorker.addEventListener("controllerchange", () => res(true), { once: true });
          }),
        ),
      { timeout: 20_000 },
    );
    const swState = await page.evaluate(() => ({
      controller: !!navigator.serviceWorker.controller,
      ready: true,
    }));
    console.log("[test] SW state:", swState);
    if (!swState.controller) throw new Error("SW is not controlling the page after install");

    // ---- Phase 2: mutate sw.js → trigger update → wait for banner ----
    console.log("\n[test] Phase 2 — trigger SW update (mutate sw.js + registration.update())...");

    // Append a comment so the byte content changes → browser detects a new SW
    await appendFile(SW_PATH, "\n// test-update-marker\n");
    console.log("[test] sw.js mutated");

    // Force the browser to check for an update
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    console.log("[test] registration.update() called");

    // Wait for the UpdateBanner to appear (workbox fires 'waiting' when new SW is installed+waiting)
    console.log("[test] waiting for UpdateBanner (timeout 30 s)...");
    await page.waitForSelector("text=Update available", { timeout: 30_000 });
    console.log("[test] ✅ UpdateBanner visible!");

    // Verify loading state on click
    const refreshBtn = page.getByRole("button", { name: /^Refresh$/ });
    await refreshBtn.waitFor({ state: "visible", timeout: 5_000 });

    // ---- Phase 3: click Refresh → expect page reload ----
    console.log("\n[test] Phase 3 — click Refresh, expect page reload...");
    const reloadPromise = page.waitForEvent("load", { timeout: 8_000 });
    await refreshBtn.click();

    // Verify button went into loading state
    const updatingBtn = page.getByRole("button", { name: /Updating/ });
    // (non-blocking: race between reload and this check)
    const loadingVisible = await updatingBtn.isVisible().catch(() => false);
    console.log("[test] loading state visible:", loadingVisible);

    await reloadPromise;
    console.log("[test] ✅ Page reloaded!");

    await ctx.close();
    passed = true;

  } finally {
    await browser.close();
    await cleanup();
  }

  if (passed) {
    console.log("\n✅ PASS: UpdateBanner Refresh button correctly triggers page reload.");
    process.exit(0);
  } else {
    console.error("\n❌ FAIL");
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error("\n❌ FAIL:", err.message);
  await cleanup();
  process.exit(1);
});
