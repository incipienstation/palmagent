import { test, expect } from "@playwright/test";

// Use full Chromium: the default headless shell denies notification permissions.
// This verifies the browser contract; it does not emulate Android's status bar.
test.use({ channel: "chromium", permissions: ["notifications"], isMobile: false, serviceWorkers: "allow" });

test("push uses a transparent logo badge that is available offline", async ({ page, context, baseURL }) => {
  const cdp = await context.newCDPSession(page);
  let registrationId: string | undefined;
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
    const registration = registrations.find((entry) => entry.scopeURL === `${baseURL}/` && !entry.isDeleted);
    if (registration) registrationId = registration.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  await context.grantPermissions(["notifications"], { origin: baseURL });
  await page.goto("/");
  expect(await page.evaluate(() => Notification.permission)).toBe("granted");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await expect.poll(() => registrationId).toBeTruthy();
  // Check the cold asset before push delivery can warm notification assets.
  await context.setOffline(true);
  // Verify offline availability through a real read, without inspecting cache names.
  const badge = await page.evaluate(async () => {
    const response = await fetch("/notification-badge.png");
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/png")) {
      throw new Error("Badge must be a cached PNG, not an SPA fallback");
    }
    const image = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let visible = 0;
    let colored = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      visible++;
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) colored++;
    }
    return { colored, visible, pixels: image.width * image.height };
  });
  expect(badge.colored).toBe(0);
  expect(badge.visible).toBeGreaterThan(0);
  expect(badge.visible).toBeLessThan(badge.pixels);
  await context.setOffline(false);
  await cdp.send("ServiceWorker.deliverPushMessage", {
    origin: baseURL!, registrationId: registrationId!,
    data: JSON.stringify({ title: "Task completed", body: "Ready for review", taskId: "badge-test", url: "/#/task/badge-test" }),
  });
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const [notification] = await registration.getNotifications({ tag: "badge-test" });
    return notification ? {
      title: notification.title, body: notification.body,
      icon: new URL(notification.icon).pathname, badge: new URL(notification.badge).pathname,
      url: notification.data.url,
    } : null;
  })).toEqual({
    title: "Task completed", body: "Ready for review",
    icon: "/icon-192.png", badge: "/notification-badge.png", url: "/#/task/badge-test",
  });

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    for (const notification of await registration.getNotifications()) notification.close();
  });
});
