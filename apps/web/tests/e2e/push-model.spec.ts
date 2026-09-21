import { test, expect } from "@playwright/test";
import { deferred, pushModel } from "./_push-model";

function settled(model: ReturnType<typeof pushModel>, checked: boolean) {
  expect(model.getPushPreference()).toMatchObject({ checked, pending: false, requestingPermission: false });
  expect(model.probe.subscribed).toBe(checked);
  expect(model.work()).toBe(0);
}

for (const result of ["denied", "default"] as const) {
  test(`push permission ${result} is requested synchronously before debounce`, async () => {
    const model = pushModel("default");
    await model.refreshPushPreference();
    model.setPushPreference(true);
    expect(model.probe.permissionRequests).toBe(1);
    expect(model.getPushPreference()).toMatchObject({ checked: false, requestingPermission: true, pending: true });
    model.setPushPreference(true);
    expect(model.probe.permissionRequests).toBe(1);
    await model.advance(250);
    expect(model.probe.subscriptions).toBe(0);
    await model.resolvePermission(result);
    await model.advance(250);
    settled(model, false);
    expect(model.probe.subscriptions).toBe(0);
    expect(model.probe.toasts[0].title).toContain(result === "denied" ? "blocked" : "not granted");
    if (result === "default") {
      model.setPushPreference(true);
      expect(model.probe.permissionRequests).toBe(2);
      await model.resolvePermission("granted");
      await model.advance(250);
      settled(model, true);
    }
  });
}

test("push key failure rolls back and allows retry without subscribing", async () => {
  const model = pushModel();
  model.probe.request = async operation => { if (operation === "key") throw new Error("Unavailable"); };
  await model.refreshPushPreference();
  model.setPushPreference(true);
  await model.advance(250);
  settled(model, false);
  expect(model.probe.subscriptions).toBe(0);
  expect(model.probe.toasts).toHaveLength(1);
  expect(model.probe.toasts[0].title).toMatch(/notifications.*try again/i);
  model.probe.request = async () => {};
  model.setPushPreference(true);
  await model.advance(250);
  settled(model, true);
});

for (const latest of [false, true]) {
  test(`obsolete push failure preserves latest ${latest ? "ON" : "OFF"} without a stale toast`, async () => {
    const model = pushModel(); const first = deferred(); let registrations = 0;
    model.probe.request = async operation => {
      if (operation === "subscribe" && ++registrations === 1) await first.promise;
    };
    await model.refreshPushPreference();
    model.setPushPreference(true); await model.advance(250);
    expect(registrations).toBe(1);
    model.setPushPreference(false);
    if (latest) model.setPushPreference(true);
    first.reject(new Error("Old request failed")); await model.turn(); await model.advance(250);
    settled(model, latest);
    expect(registrations).toBe(latest ? 2 : 1);
    expect(model.probe.toasts).toEqual([]);
  });
}

test("OFF during push registration cleans up its late success", async () => {
  const model = pushModel(); const first = deferred();
  model.probe.request = async operation => { if (operation === "subscribe") await first.promise; };
  await model.refreshPushPreference();
  model.setPushPreference(true); await model.advance(250);
  expect(model.probe.calls).toEqual(["key", "subscribe"]);
  model.setPushPreference(false); await model.advance(250);
  first.resolve(); await model.turn();
  settled(model, false);
  expect(model.probe.calls).toEqual(["key", "subscribe", "unsubscribe"]);
});

test("OFF then ON awaits server cleanup before registering again", async () => {
  const model = pushModel("granted", true); const cleanup = deferred();
  model.probe.request = async operation => { if (operation === "unsubscribe") await cleanup.promise; };
  await model.refreshPushPreference();
  model.setPushPreference(false); await model.advance(250);
  expect(model.probe.calls).toEqual(["unsubscribe"]);
  model.setPushPreference(true); await model.advance(250);
  expect(model.probe.calls).toEqual(["unsubscribe"]);
  cleanup.resolve(); await model.turn();
  settled(model, true);
  expect(model.probe.calls).toEqual(["unsubscribe", "key", "subscribe"]);
});

for (const failure of ["server", "browser"] as const) {
  test(`push ${failure} unsubscribe failure restores the subscription and ON state`, async () => {
    const model = pushModel("granted", true);
    model.probe.request = async operation => { if (operation === "unsubscribe" && failure === "server") throw new Error("Unavailable"); };
    model.probe.failUnsubscribe = failure === "browser";
    await model.refreshPushPreference();
    model.setPushPreference(false); await model.advance(250);
    settled(model, true);
    expect(model.probe.calls).toEqual(failure === "server" ? ["unsubscribe"] : ["unsubscribe", "subscribe"]);
    expect(model.probe.toasts).toHaveLength(1);
    expect(model.probe.toasts[0].title).toMatch(/notifications.*try again/i);
  });
}
