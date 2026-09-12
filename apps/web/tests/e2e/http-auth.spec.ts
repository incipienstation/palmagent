import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test.use({ ignoreHTTPSErrors: true, serviceWorkers: "block" });

test("real HTTPS passkey enrollment and login preserve session and challenge cookies", async ({ page, context }) => {
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
    await page.goto(`${ready.origin}/#/enroll/${ready.token}`);
    const registration = page.waitForResponse((response) => response.url().endsWith("/api/auth/register/verify"));
    await page.getByRole("button", { name: "Register this device", exact: true }).click();
    const registered = await registration;
    expect(registered.status(), await registered.text()).toBe(201);
    expect((await registered.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie")).toHaveLength(2);
    const cookies = await context.cookies(ready.origin);
    expect(cookies.some((cookie) => cookie.name === "wa_chal")).toBe(false);
    expect(cookies.find((cookie) => cookie.name === "palmagent_session")).toMatchObject({ secure: true, httpOnly: true, sameSite: "Lax" });
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(200);
    await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(401);
    expect((await context.request.post(`${ready.origin}/api/auth/register/options`, { data: { token: ready.token } })).status()).toBe(403);
    await page.goto(ready.origin);
    const login = page.waitForResponse((response) => response.url().endsWith("/api/auth/login/verify"));
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    const loggedIn = await login;
    expect(loggedIn.status(), await loggedIn.text()).toBe(200);
    expect((await loggedIn.headersArray()).filter((header) => header.name.toLowerCase() === "set-cookie")).toHaveLength(2);
    expect((await context.request.get(`${ready.origin}/api/tasks`)).status()).toBe(200);
    expect((await context.cookies(ready.origin)).some((cookie) => cookie.name === "wa_chal")).toBe(false);
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
