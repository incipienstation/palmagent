#!/usr/bin/env node
/**
 * Standalone smoke-test: automatic screen transitions with a REAL service worker.
 * The regular Playwright harness can't cover this because it uses a mock backend
 * with no real SW lifecycle (install → wait → skip → reload).
 *
 * Prerequisites: pnpm --filter @palmagent/web build
 *
 * Run from repo root:
 *   node apps/web/scripts/test-sw-update.mjs
 */

import assert from "node:assert/strict";
import { createWebHarness } from "./web-harness.mjs";
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let SW_PATH;
let BASE;

let harness;
let interrupted;
const cleanup = async () => { await harness?.close(); };
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = signal === "SIGINT" ? 130 : 143;
  if (harness) void cleanup().then(() => process.exit(interrupted));
});

// ---- test -------------------------------------------------------------
async function run() {
  execFileSync(process.execPath, ["--test", fileURLToPath(new URL("./test-pwa-state.mjs", import.meta.url)), fileURLToPath(new URL("./test-web-harness.mjs", import.meta.url))], { stdio: "inherit" });
  harness = await createWebHarness({ count: 1, env: { PWA_UPDATE_TARGET: "0.1.0-alpha.5" } });
  if (interrupted) { await cleanup(); process.exit(interrupted); }
  SW_PATH = join(harness.dist, "sw.js");
  BASE = harness.urls[0];

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });

  let passed = false;
  try {
    // ---- Phase 1: fresh context, SW installs and activates on first load ----
    console.log("\n[test] Phase 1 — first load, wait for SW to activate...");
    const ctx = await browser.newContext({ baseURL: BASE });
    ctx.setDefaultTimeout(15_000);

    // Forward browser console so we can see workbox logs
    await ctx.addInitScript(() => {
      const original = ServiceWorker.prototype.postMessage;
      ServiceWorker.prototype.postMessage = function(message, ...args) {
        console.log("[test] worker message", message.type, this.state);
        return original.call(this, message, ...args);
      };
    });
    const page = await ctx.newPage();
    page.on("console", (m) => {
      console.log(`  [browser:${m.type()}] ${m.text()}`);
    });

    const mutations = [];
    page.on("request", (request) => {
      if (!["GET", "HEAD"].includes(request.method())) mutations.push({ url: request.url(), body: request.postDataJSON() });
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
      undefined, { timeout: 20_000 },
    );
    const swState = await page.evaluate(() => ({
      controller: !!navigator.serviceWorker.controller,
      ready: true,
    }));
    console.log("[test] SW state:", swState);
    const workerVersion = await page.evaluate(() => new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => reject(new Error("Worker version response timed out")), 3000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer); channel.port1.close(); resolve(event.data.version);
      };
      navigator.serviceWorker.controller.postMessage({ type: "PALMAGENT_VERSION" }, [channel.port2]);
    }));
    assert.equal(workerVersion, JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).version);
    assert.equal(await page.getByText("Updating Palmagent…", { exact: true }).count(), 0, "first installation is not an update");
    if (!swState.controller) throw new Error("SW is not controlling the page after install");

    // Two tabs have different drafts; activation in one must preserve both.
    await page.goto("/#/new");
    await page.getByLabel("Prompt").fill("Keep this unsent draft");
    await page.getByRole("button", { name: "Configure task settings" }).click();
    await page.getByPlaceholder("short label").fill("Draft title");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    await page.getByLabel("Attach photos", { exact: true }).setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: png });
    await page.getByAltText("attachment 1").waitFor();
    const second = await ctx.newPage();
    await second.goto("/#/new");
    await second.getByLabel("Prompt").fill("Independent second-tab draft");
    await second.evaluate(() => document.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));

    await page.bringToFront();
    await page.getByLabel("Prompt").focus();
    await page.getByLabel("Prompt").evaluate((el) => el.setSelectionRange(4, 9));
    const reload = page.waitForEvent("load", { timeout: 20_000 });
    let secondLoads = 0;
    second.on("load", () => secondLoads++);
    await appendFile(SW_PATH, "\n// automatic-update-one\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await reload.catch(async (error) => {
      console.log("[test] transition state", await page.evaluate(async () => ({ visibility: document.visibilityState,
        banner: document.querySelector('[role="status"]')?.textContent,
        waiting: (await navigator.serviceWorker.getRegistration())?.waiting?.state,
        marker: sessionStorage.getItem("palmagent:screen-checkpoint") })));
      throw error;
    });
    await page.getByAltText("attachment 1").waitFor();
    assert.equal(await page.getByLabel("Prompt").inputValue(), "Keep this unsent draft");
    assert.equal(await page.evaluate(() => localStorage.getItem("draft:dispatch-title")), "Draft title");
    await page.waitForFunction(() => document.activeElement?.tagName === "TEXTAREA");
    assert.deepEqual(await page.getByLabel("Prompt").evaluate((el) => [el.selectionStart, el.selectionEnd]), [4, 9]);
    assert(page.url().endsWith("/#/new"));
    assert.equal(secondLoads, 0, "another tab must not reload during text composition");
    await second.bringToFront();
    const secondReload = second.waitForEvent("load", { timeout: 20_000 });
    await second.evaluate(() => document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await secondReload;
    await second.getByLabel("Prompt").waitFor();
    assert.equal(await second.getByLabel("Prompt").inputValue(), "Independent second-tab draft");
    assert.equal(secondLoads, 1);
    console.log("[test] automatic transition preserves drafts, attachments, and independent tabs");

    await page.bringToFront();
    // A checkpoint failure must preserve the page; retry after the browser can
    // save again. No periodic update check or force-reload fallback is involved.
    await page.evaluate(() => {
      window.__originalOpen = indexedDB.open.bind(indexedDB);
      indexedDB.open = () => { throw new Error("Simulated storage failure"); };
    });
    let loads = 0;
    page.on("load", () => loads++);
    await appendFile(SW_PATH, "\n// automatic-update-two\n");
    // Prevent the other tab from activating while this tab is testing failure.
    await second.close();
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await page.getByText("Update paused", { exact: true }).waitFor({ timeout: 20_000 });
    assert.equal(loads, 0);
    assert.equal(await page.getByLabel("Prompt").inputValue(), "Keep this unsent draft");
    const recovered = page.waitForEvent("load", { timeout: 20_000 });
    await page.evaluate(() => { indexedDB.open = window.__originalOpen; window.dispatchEvent(new Event("online")); });
    await recovered;
    await page.getByAltText("attachment 1").waitFor();
    assert.equal(await page.getByLabel("Prompt").inputValue(), "Keep this unsent draft");
    assert.equal(loads, 1, "recovery completes with one automatic reload");
    await page.waitForTimeout(1800);
    assert.equal(loads, 1, "the same update must not cause a reload loop");
    console.log("[test] storage failures preserve work and event-driven recovery completes automatically");

    await page.getByRole("button", { name: "Configure task settings" }).click();
    await page.getByRole("radio", { name: "opus", exact: true }).click();
    await page.getByPlaceholder("short label").fill("Restored configuration");
    const configurationReload = page.waitForEvent("load", { timeout: 20_000 });
    await appendFile(SW_PATH, "\n// automatic-update-configuration\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await configurationReload;
    await page.getByRole("heading", { name: "Configure", exact: true }).waitFor();
    assert.equal(await page.getByPlaceholder("short label").inputValue(), "Restored configuration");
    assert.equal(await page.getByRole("radio", { name: "opus", exact: true }).getAttribute("aria-checked"), "true");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    assert.equal(await page.getByLabel("Prompt").inputValue(), "Keep this unsent draft");
    console.log("[test] open composer configuration survives an automatic update");

    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("option", { name: "Browse folders…" }).click();
    await page.getByRole("button", { name: "Choose outer-repo as repository" }).click();
    await page.getByText("✓ git repo · branch main").waitFor();
    const pickerReload = page.waitForEvent("load", { timeout: 20_000 });
    await appendFile(SW_PATH, "\n// automatic-update-picker\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await pickerReload;
    await page.getByRole("heading", { name: "Add a repo", exact: true }).waitFor();
    await page.getByText("✓ git repo · branch main").waitFor();
    assert.equal(await page.getByRole("button", { name: "Register", exact: true }).count(), 1);
    console.log("[test] repository selection survives without registering it automatically");

    // Keep an earlier conversation page and its reading position through an
    // offline delay and transition. REST restores saved history; SSE starts at
    // the live boundary and carries no history cursor in its URL.
    await page.evaluate(() => { localStorage.setItem("pref:output-mode", "verbose"); });
    await page.goto("/#/task/t-run");
    await page.reload();
    const transcript = page.locator('[aria-label="Session transcript"]');
    await page.getByText("tool_result: Transition tool 440", { exact: true }).waitFor();
    const olderPage = page.waitForResponse((response) => response.url().includes("/history?before=241"));
    await transcript.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 0; });
    await olderPage;
    await page.waitForTimeout(400);
    const oldestPage = page.waitForResponse((response) => response.url().includes("/history?before=41"));
    await transcript.evaluate((el) => { el.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 })); el.scrollTop = 350; });
    const oldestResponse = await oldestPage;
    assert.equal((await oldestResponse.json()).before, null, "the oldest REST page closes history pagination");
    // Early loading can exhaust history before the reader reaches its edge.
    // Wait for its measured prepend to settle without a decorative end marker.
    await page.getByText("Loading earlier messages…", { exact: true }).waitFor({ state: "detached" });
    await page.waitForTimeout(400);
    assert.equal(await page.getByText("Beginning of conversation", { exact: true }).count(), 0);
    const position = await transcript.evaluate((el) => el.scrollTop);
    assert(position > 100);
    const draft = page.getByPlaceholder("Message the agent…");
    await draft.fill("Do not submit this conversation draft");
    const reconnects = [];
    page.on("request", (request) => { if (request.url().includes("/api/stream?task=t-run")) reconnects.push(request.url()); });
    const beforeConversation = loads;
    await page.evaluate(() => document.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await appendFile(SW_PATH, "\n// automatic-update-history\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r?.waiting)));
    await ctx.setOffline(true);
    await page.evaluate(() => document.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await page.waitForTimeout(1100);
    assert.equal(loads, beforeConversation, "offline screens must not transition");
    const conversationReload = page.waitForEvent("load", { timeout: 20_000 });
    await ctx.setOffline(false);
    await conversationReload;
    await draft.waitFor();
    assert.equal(await draft.inputValue(), "Do not submit this conversation draft");
    assert.equal(await page.getByText("Beginning of conversation", { exact: true }).count(), 0);
    await page.waitForFunction((position) => {
      const el = document.querySelector('[aria-label="Session transcript"]');
      return el && Math.abs(el.scrollTop - position) <= 2;
    }, position).catch(async (error) => {
      console.log("[test] conversation position", { expected: position, actual: await transcript.evaluate((el) => el.scrollTop), reconnects });
      throw error;
    });
    assert(reconnects.length > 0, "the task stream reconnects after recovery");
    assert(reconnects.every((url) => !new URL(url).searchParams.has("lastEventId")), "history cursors stay on REST");
    console.log("[test] earlier history, conversation position, and drafts survive offline recovery");

    // Manual installation also finishes automatically, with automatic updates
    // disabled. A pending write must settle before its page is replaced.
    await page.evaluate(() => { location.hash = "/"; });
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    const automatic = page.getByRole("switch", { name: "Automatic updates" });
    assert.equal(await automatic.isChecked(), false);
    const submitted = page.waitForRequest((request) => request.url().endsWith("/api/settings/updates") && request.postDataJSON()?.action === "install");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await submitted;
    const beforeInstall = loads;
    await appendFile(SW_PATH, "\n// automatic-update-three\n");
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
    await page.waitForTimeout(1100);
    assert.equal(loads, beforeInstall, "an in-flight install response blocks the screen transition");
    await page.waitForEvent("load", { timeout: 20_000 });
    await page.getByRole("heading", { name: "Updates", exact: true }).waitFor();
    assert.equal(await automatic.isChecked(), false);
    assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).count(), 0);
    assert.equal(mutations.filter((request) => request.body?.action === "install").length, 1);
    assert(!mutations.some((request) => /\/api\/tasks(?:\/|$)/.test(new URL(request.url).pathname)), "screen transitions must not send agent lifecycle actions");
    assert.equal(loads, beforeInstall + 1);
    console.log("[test] one Update click waits for its response, restores Settings, and sends no agent actions");

    await ctx.close();
    passed = true;

  } finally {
    await browser.close();
    await cleanup();
  }

  if (passed) {
    console.log("\n✅ PASS: Automatic PWA transitions preserve browser state without a confirmation click.");
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
