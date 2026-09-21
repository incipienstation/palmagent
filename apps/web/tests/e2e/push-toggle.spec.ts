import { test, expect, type Page } from "@playwright/test";
import { assertViewportLocked } from "./_helpers";

// Browser coverage retains permission prompts, feedback, and Settings lifetime.
test.use({ serviceWorkers: "block" });

type PushProbe = {
  permissionRequests: number;
  subscriptions: number;
  subscribed: boolean;
  failUnsubscribe: boolean;
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
    const probe: PushProbe = { permissionRequests: 0, subscriptions: 0, subscribed, failUnsubscribe: false };
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
        if (probe.failUnsubscribe) return false;
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

for (const result of ["granted", "denied", "default"] as const) {
  test(`first browser prompt stays off until ${result}, with no debounced permission request`, async ({ page }) => {
    const registration = holdRequest();
    await page.route("**/api/push/subscribe", async (route) => {
      await registration.pending;
      await route.fulfill({ json: { ok: true } });
    });
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    const toggle = await openPush(page, "default");
    await page.clock.pauseAt(new Date("2026-01-01T00:01:00Z"));
    await toggle.evaluate((el: HTMLElement) => el.click());
    // No clock advance: the browser prompt must be requested in the click handler.
    expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(1);
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: /permission/i })).toBeVisible();
    expect(await page.evaluate(() => window.pushProbe.subscriptions)).toBe(0);
    await page.evaluate((permission) => window.pushProbe.resolvePermission!(permission), result);
    await expect(toggle).toBeEnabled();
    if (result === "granted") {
      await expect(toggle).toBeChecked();
      await page.clock.runFor(250);
      await expect.poll(() => page.evaluate(() => window.pushProbe.subscriptions)).toBe(1);
      await expect(toggle).toHaveAttribute("aria-busy", "true");
      registration.release();
      await settled(page, true);
    } else {
      await expect(toggle).not.toBeChecked();
      await page.clock.runFor(250);
      await expect(currentToast(page)).toContainText(result === "denied" ? "blocked" : "not granted");
      await settled(page, false);
      if (result === "default") {
        await toggle.evaluate((el: HTMLElement) => el.click());
        expect(await page.evaluate(() => window.pushProbe.permissionRequests)).toBe(2);
        await page.evaluate(() => window.pushProbe.resolvePermission!("granted"));
        registration.release();
        await page.clock.runFor(250);
        await settled(page, true);
      }
    }
  });
}

for (const failingEndpoint of ["key", "subscribe"] as const) {
  test(`${failingEndpoint} failure rolls back with a toast and permits retry`, async ({ page }, testInfo) => {
    const response = holdRequest();
    await page.route(`**/api/push/${failingEndpoint}`, async (route) => {
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
    await page.unroute(`**/api/push/${failingEndpoint}`);
    await toggle.click();
    await settled(page, true);
  });
}

for (const latest of [false, true]) {
  test(`an obsolete registration failure preserves latest ${latest ? "ON" : "OFF"} without a stale toast`, async ({ page }) => {
    const first = holdRequest();
    let registrations = 0;
    await page.route("**/api/push/subscribe", async (route) => {
      registrations++;
      if (registrations === 1) {
        await first.pending;
        await route.fulfill({ status: 500, json: { error: "Old request failed" } });
      } else await route.fulfill({ json: { ok: true } });
    });
    const toggle = await openPush(page);
    await toggle.click();
    await expect.poll(() => registrations).toBe(1);
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    if (latest) {
      await toggle.click();
      await expect(toggle).toBeChecked();
    }
    first.release();
    await settled(page, latest);
    expect(registrations).toBe(latest ? 2 : 1);
    await expect(currentToast(page)).toHaveCount(0);
  });
}

test("OFF during registration remains off when the old success arrives and completes cleanup", async ({ page }) => {
  const first = holdRequest();
  const operations: string[] = [];
  await page.route("**/api/push/subscribe", async (route) => {
    operations.push("subscribe");
    await first.pending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/push/unsubscribe", async (route) => {
    operations.push("unsubscribe");
    await route.fulfill({ json: { ok: true } });
  });
  const toggle = await openPush(page);
  await toggle.click();
  await expect.poll(() => operations.length).toBe(1);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  first.release();
  await settled(page, false);
  expect(operations).toEqual(["subscribe", "unsubscribe"]);
});

test("OFF then ON serializes server cleanup before re-registration", async ({ page }) => {
  const cleanup = holdRequest();
  const operations: string[] = [];
  let overlapping = false;
  let cleaning = false;
  await page.route("**/api/push/unsubscribe", async (route) => {
    operations.push("unsubscribe");
    cleaning = true;
    await cleanup.pending;
    cleaning = false;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/push/subscribe", async (route) => {
    overlapping ||= cleaning;
    operations.push("subscribe");
    await route.fulfill({ json: { ok: true } });
  });
  const toggle = await openPush(page, "granted", true);
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => operations.length).toBe(1);
  await toggle.click();
  await expect(toggle).toBeChecked();
  cleanup.release();
  await settled(page, true);
  expect(operations).toEqual(["unsubscribe", "subscribe"]);
  expect(overlapping).toBe(false);
});

for (const failure of ["server", "browser"] as const) {
  test(`${failure} unsubscribe failure restores ON with a toast`, async ({ page }) => {
    let restored = false;
    if (failure === "server") {
      await page.route("**/api/push/unsubscribe", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }));
    } else {
      await page.route("**/api/push/subscribe", route => {
        restored = true;
        return route.fulfill({ json: { ok: true } });
      });
    }
    const toggle = await openPush(page, "granted", true);
    if (failure === "browser") await page.evaluate(() => { window.pushProbe.failUnsubscribe = true; });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await settled(page, true);
    await expect(currentToast(page)).toContainText(/notifications.*try again/i);
    expect(restored).toBe(failure === "browser");
  });
}

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
