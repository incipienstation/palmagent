import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import brand from "../../src/brand.json" with { type: "json" };

test.use({ ignoreHTTPSErrors: true, serviceWorkers: "block" });

test("real HTTPS passkeys protect enrollment, login, removal, and session revocation", async ({ page, context, browser }) => {
  test.setTimeout(90_000);
  const dir = mkdtempSync(join(tmpdir(), "palmagent-http-auth-"));
  const tests = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["--import", "tsx", join(tests, "real-auth-server.mjs")], {
    cwd: resolve(tests, "../../server"),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, HTTP_TEST_DIR: dir, NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let logs = "";
  child.stdout!.on("data", (data) => { logs += data.toString(); });
  child.stderr!.on("data", (data) => { logs += data.toString(); });
  try {
    const ready = await new Promise<{ origin: string; token: string }>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`HTTPS fixture timed out: ${logs}`)), 10_000);
      child.once("message", (message) => { clearTimeout(deadline); resolve(message as { origin: string; token: string }); });
      child.once("exit", () => { clearTimeout(deadline); reject(new Error(`HTTPS fixture exited: ${logs}`)); });
      child.once("error", reject);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    // The saved theme must apply under the real CSP before the app module runs.
    await page.addInitScript(() => localStorage.setItem("theme", "light"));
    let releaseModule!: () => void;
    const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
    const mainModule = "**/assets/index-*.js";
    await page.route(mainModule, async route => { await moduleGate; await route.continue(); });
    try {
      await page.goto(`${ready.origin}/#/enroll/${ready.token}`, { waitUntil: "commit" });
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand.light.chrome);
    } finally {
      releaseModule();
    }
    const registration = page.waitForResponse((response) => response.url().endsWith("/api/auth/register/verify"));
    await page.getByRole("button", { name: "Register this device", exact: true }).click();
    const registered = await registration;
    expect(registered.status(), await registered.text()).toBe(201);
    expect((await registered.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie")).toHaveLength(2);
    const cookies = await context.cookies(ready.origin);
    expect(cookies.some((cookie) => cookie.name === "wa_chal")).toBe(false);
    expect(cookies.find((cookie) => cookie.name === "palmagent_session")).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax" });
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(200);
    await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
    const other = await context.newPage();
    try {
      await other.goto(ready.origin);
      await expect(other.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      const logout = page.waitForResponse(response => response.url().endsWith("/api/auth/logout"));
      await page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true }).click();
      expect((await logout).status()).toBe(200);
      await expect(other.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
      await expect(other.getByRole("button", { name: "Open navigation", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    } finally { await other.close(); }
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(401);
    expect((await context.request.post(`${ready.origin}/api/auth/register/options`, { headers: { origin: ready.origin }, data: { token: ready.token } })).status()).toBe(403);
    const login = page.waitForResponse((response) => response.url().endsWith("/api/auth/login/verify"));
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    const loggedIn = await login;
    expect(loggedIn.status(), await loggedIn.text()).toBe(200);
    await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
    expect((await loggedIn.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie")).toHaveLength(2);
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(200);
    expect((await context.cookies(ready.origin)).some((cookie) => cookie.name === "wa_chal")).toBe(false);

    // Real passkey reauthentication authorizes one enrollment link. A separate
    // browser context owns the new passkey and must lose access when it is removed.
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Security", exact: true }).click();
    await page.getByRole("button", { name: "Create enrollment link" }).click();
    const link = page.locator('a[href*="/#/enroll/"]');
    await expect(link).toBeVisible();
    const url = await link.getAttribute("href");
    const device = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    try {
      const devicePage = await device.newPage();
      const deviceCdp = await device.newCDPSession(devicePage);
      await deviceCdp.send("WebAuthn.enable");
      await deviceCdp.send("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      await devicePage.goto(url!);
      await devicePage.getByRole("button", { name: "Register this device", exact: true }).click();
      await expect(devicePage.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      expect((await device.request.get(`${ready.origin}/api/tasks`)).status()).toBe(200);
      const listed = await (await context.request.get(`${ready.origin}/api/auth/passkeys`)).json();
      expect(listed.passkeys).toHaveLength(2);
      // All auth mutations reject foreign or missing origins even with a cookie.
      for (const headers of [{}, { origin: "https://sibling.example" }]) {
        expect((await context.request.post(`${ready.origin}/api/auth/logout`, { headers })).status()).toBe(403);
      }
      await page.getByRole("button", { name: "Back to settings" }).click();
      await expect(page.getByRole("button", { name: "Security", exact: true })).toBeFocused();
      await page.getByRole("button", { name: "Security", exact: true }).click();
      await expect(page.getByRole("button", { name: /^Remove / })).toHaveCount(2);
      const viewport = page.viewportSize()!;
      for (const width of [360, 1280]) {
        await page.setViewportSize({ width, height: 780 });
        await expect(page.getByRole("button", { name: "Sign out all devices", exact: true })).toBeInViewport();
        if (process.env.VISUAL_REVIEW_DIR) await page.screenshot({ path: join(process.env.VISUAL_REVIEW_DIR, `security-${width}.png`) });
      }
      await page.setViewportSize(viewport);
      await page.getByRole("button", { name: /^Remove / }).last().click();
      await page.getByRole("button", { name: "Verify and continue" }).click();
      await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
      expect((await device.request.get(`${ready.origin}/api/tasks`)).status()).toBe(401);
      await expect(devicePage.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
      await page.getByRole("button", { name: "Sign in with passkey" }).click();
      await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Security", exact: true }).click();
      await page.getByRole("button", { name: "Sign out all devices", exact: true }).click();
      await page.getByRole("button", { name: "Verify and continue" }).click();
      await expect(page.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    } finally { await device.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
      await closed; clearTimeout(deadline);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
