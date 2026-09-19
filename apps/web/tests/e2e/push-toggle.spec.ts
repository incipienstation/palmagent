import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

test.use({ serviceWorkers: "block" });

type PushProbe = {
  permissionRequests: number;
  subscriptions: number;
  subscribed: boolean;
  resolvePermission?: (permission: NotificationPermission) => void;
};

declare global {
  interface Window { pushProbe: PushProbe }
}

async function openPush(page: Page, permission: NotificationPermission = "granted") {
  await page.addInitScript((initialPermission) => {
    let permission = initialPermission;
    const probe: PushProbe = { permissionRequests: 0, subscriptions: 0, subscribed: false };
    window.pushProbe = probe;
    Object.defineProperty(window, "Notification", { configurable: true, value: {
      get permission() { return permission; },
      requestPermission: () => {
        probe.permissionRequests++;
        return new Promise<NotificationPermission>((resolve) => {
          probe.resolvePermission = (next) => { permission = next; resolve(next); };
        });
      },
    } });
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    const subscription = {
      endpoint: "https://push.example.test/subscription",
      toJSON: () => ({ keys: { p256dh: "test", auth: "test" } }),
      unsubscribe: async () => { probe.subscribed = false; return true; },
    };
    Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, value: Promise.resolve({
      pushManager: {
        getSubscription: async () => probe.subscribed ? subscription : null,
        subscribe: async () => { probe.subscriptions++; probe.subscribed = true; return subscription; },
      },
    }) });
  }, permission);
  await page.goto("/");
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Push notifications" });
  await expect(toggle).toBeVisible();
  return toggle;
}

function holdRequest() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release: () => release() };
}

test("granted permission switches on before network completion and prevents duplicate subscriptions", async ({ page }, testInfo) => {
  const key = holdRequest();
  const registration = holdRequest();
  await page.route("**/api/push/key", async (route) => {
    await key.pending;
    await route.fulfill({ json: { publicKey: "AQID" } });
  });
  await page.route("**/api/push/subscribe", async (route) => {
    await registration.pending;
    await route.fulfill({ json: { ok: true } });
  });
  const toggle = await openPush(page);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("status").filter({ hasText: "Enabling…" })).toBeVisible();
  expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(0);
  await assertViewportLocked(page);
  await page.screenshot({ path: testInfo.outputPath("push-enabling.png") });
  key.release();
  await expect.poll(() => page.evaluate(() => window.pushProbe.subscriptions)).toBe(1);
  await toggle.dispatchEvent("click");
  expect(await page.evaluate(() => window.pushProbe.subscriptions)).toBe(1);
  await expect(toggle).toBeDisabled();
  registration.release();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await expect(page.getByText("Enabling…", { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
});

for (const result of ["granted", "denied", "default"] as const) {
  test(`first permission request waits for ${result} before changing the switch`, async ({ page }) => {
    const registration = holdRequest();
    await page.route("**/api/push/subscribe", async (route) => {
      await registration.pending;
      await route.fulfill({ json: { ok: true } });
    });
    const toggle = await openPush(page, "default");
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(page.getByText("Waiting for permission…", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(1);
    await page.evaluate((permission) => window.pushProbe.resolvePermission!(permission), result);
    if (result === "granted") {
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeDisabled();
      await expect(page.getByText("Enabling…", { exact: true })).toBeVisible();
      registration.release();
      await expect(toggle).toBeEnabled();
    } else {
      await expect(toggle).not.toBeChecked();
      expect(await page.evaluate(() => window.pushProbe.subscriptions)).toBe(0);
      if (result === "denied") {
        await expect(toggle).toBeDisabled();
        await expect(page.getByText("Blocked in browser settings")).toBeVisible();
      } else {
        await expect(toggle).toBeEnabled();
        await expect(page.getByText("Permission was not granted. Turn on to try again.")).toBeVisible();
      }
    }
  });
}

for (const failingEndpoint of ["key", "subscribe"] as const) {
  test(`${failingEndpoint} failure restores off and allows a successful retry`, async ({ page }, testInfo) => {
    const response = holdRequest();
    await page.route(`**/api/push/${failingEndpoint}`, async (route) => {
      await response.pending;
      await route.fulfill({ status: 500, json: { error: "Registration unavailable" } });
    });
    const toggle = await openPush(page);
    await toggle.click();
    await expect(toggle).toBeChecked();
    response.release();
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText("Could not update push notifications. Try again.")).toBeVisible();
    expect(await page.evaluate(() => window.pushProbe.subscribed)).toBe(false);
    await assertViewportLocked(page);
    await page.screenshot({ path: testInfo.outputPath("push-failure.png") });
    await page.unroute(`**/api/push/${failingEndpoint}`);
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByText("Could not update push notifications. Try again.")).toHaveCount(0);
  });
}
