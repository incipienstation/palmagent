import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

// Browser coverage retains permission prompts, feedback, and Settings lifetime.
// Request ordering and failure combinations live in push-model.spec.ts.
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

const currentToast = (page: Page) => page.locator('[data-testid="toast"][data-front="true"][data-removed="false"]');
const pushToggle = (page: Page) => page.getByRole("switch", { name: "Push notifications" });

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(pushToggle(page)).toBeVisible();
  return pushToggle(page);
}

async function openPush(page: Page, permission: NotificationPermission = "granted", subscribed = false) {
  await page.addInitScript(({ initialPermission, subscribed }) => {
    let permission = initialPermission;
    const probe: PushProbe = { permissionRequests: 0, subscriptions: 0, subscribed };
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
      unsubscribe: async () => {
        probe.subscribed = false;
        return true;
      },
    };
    Object.defineProperty(navigator.serviceWorker, "ready", { configurable: true, value: Promise.resolve({
      pushManager: {
        getSubscription: async () => probe.subscribed ? subscription : null,
        subscribe: async () => { probe.subscriptions++; probe.subscribed = true; return subscription; },
      },
    }) });
  }, { initialPermission: permission, subscribed });
  await page.goto("/");
  return openSettings(page);
}

function holdRequest() {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  return { pending, release: () => release() };
}

async function settled(page: Page, checked: boolean) {
  await expect(pushToggle(page)).toHaveAttribute("aria-busy", "false");
  await expect(pushToggle(page)).toBeChecked({ checked });
  expect(await page.evaluate(() => window.pushProbe.subscribed)).toBe(checked);
}

test("each click updates immediately while only the last selection is applied after 250ms", async ({ page }) => {
  let keyRequests = 0;
  await page.route("**/api/push/key", async (route) => {
    keyRequests++;
    await route.fulfill({ json: { publicKey: "AQID" } });
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const toggle = await openPush(page);
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await toggle.evaluate((el: HTMLElement) => el.click());
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.clock.runFor(100);
  await toggle.evaluate((el: HTMLElement) => el.click());
  await expect(toggle).not.toBeChecked();
  await page.clock.runFor(250);
  await settled(page, false);
  expect(keyRequests).toBe(0);

  await toggle.evaluate((el: HTMLElement) => el.click());
  await expect(toggle).toBeChecked();
  await page.clock.runFor(100);
  await toggle.evaluate((el: HTMLElement) => el.click());
  await expect(toggle).not.toBeChecked();
  await toggle.evaluate((el: HTMLElement) => el.click());
  await expect(toggle).toBeChecked();
  await page.clock.runFor(249);
  expect(keyRequests).toBe(0);
  await page.clock.runFor(1);
  await settled(page, true);
  expect(keyRequests).toBe(1);
  expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(0);
});

test("first browser prompt stays off until granted, with no debounced permission request", async ({ page }) => {
  const registration = holdRequest();
  await page.route("**/api/push/subscribe", async (route) => {
    await registration.pending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  const toggle = await openPush(page, "default");
  await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
  await toggle.evaluate((el: HTMLElement) => el.click());
  // No clock advance: request permission synchronously from the click handler.
  expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(1);
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: /permission/i })).toBeVisible();
  expect(await page.evaluate(() => window.pushProbe.subscriptions)).toBe(0);
  await page.evaluate(() => window.pushProbe.resolvePermission!("granted"));
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  await page.clock.runFor(250);
  await expect.poll(() => page.evaluate(() => window.pushProbe.subscriptions)).toBe(1);
  await expect(toggle).toHaveAttribute("aria-busy", "true");
  registration.release();
  await settled(page, true);
});

test("subscribe failure rolls back with a toast and permits retry", async ({ page }, testInfo) => {
  const response = holdRequest();
  await page.route("**/api/push/subscribe", async (route) => {
    await response.pending;
    await route.fulfill({ status: 500, json: { error: "Registration unavailable" } });
  });
  const toggle = await openPush(page);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await assertViewportLocked(page);
  response.release();
  await settled(page, false);
  await expect(currentToast(page)).toContainText(/notifications.*try again/i);
  await page.screenshot({ path: testInfo.outputPath("push-failure-toast.png") });
  await page.unroute("**/api/push/subscribe");
  await toggle.click();
  await settled(page, true);
});

test("pending choice survives reopening Settings and failures still toast after closing", async ({ page }) => {
  const registration = holdRequest();
  let started = false;
  await page.route("**/api/push/subscribe", async (route) => {
    started = true;
    await registration.pending;
    await route.fulfill({ status: 500, json: { error: "Unavailable" } });
  });
  const toggle = await openPush(page);
  await toggle.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect.poll(() => started).toBe(true);
  await openSettings(page);
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  await page.getByRole("button", { name: "Close settings" }).click();
  registration.release();
  await expect(currentToast(page)).toContainText(/notifications.*try again/i);
  await openSettings(page);
  await settled(page, false);
});
