import { test, expect, type BrowserContext, type CDPSession } from "@playwright/test";

// Use Chromium's real CloseWatcher and trusted Escape close requests (Android
// maps system Back to the same browser primitive). Never call page.evaluate or
// locator helpers before the no-activation assertions: they can grant activation.
async function standalone(context: BrowserContext, singleEntry = false) {
  await context.addInitScript(({ singleEntry }) => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = original(query);
      if (query.includes("display-mode: standalone")) Object.defineProperty(result, "matches", { value: true });
      return result;
    };
    if (singleEntry && location.protocol.startsWith("http")) {
      history.replaceState({ __backGuard: "app", __palmagentNavigation: {
        version: 1, session: "restored-single-entry", index: 1, depth: 0, hash: "#/", kind: "page",
      } }, "", location.href);
    }
  }, { singleEntry });
}
async function passive(cdp: CDPSession, expression: string) {
  const result = await cdp.send("Runtime.evaluate", { expression, userGesture: false, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function state(cdp: CDPSession) {
  return passive(cdp, `(() => {
    const hint = [...document.querySelectorAll('[data-testid="toast"][data-removed="false"]')]
      .find(element => element.textContent.includes('Press back again to exit'));
    return { active: navigator.userActivation.hasBeenActive, guard: history.state?.__backGuard,
      length: history.length,
      text: hint?.textContent ?? '', index: window.navigation.currentEntry?.index ?? -1,
      ready: [...document.querySelectorAll('h1,h2')].some(element => element.textContent === 'Tasks') };
  })()`);
}
async function launch(context: BrowserContext) {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  await passive(cdp, `location.replace(${JSON.stringify(origin)})`);
  await expect.poll(async () => (await state(cdp)).ready).toBe(true);
  expect(await passive(cdp, "typeof CloseWatcher")).toBe("function");
  expect((await state(cdp)).active).toBe(false);
  return { page, cdp };
}
async function closeRequest(cdp: CDPSession) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
}
async function browserBack(cdp: CDPSession) {
  // Chromium handles the mouse Back button through its browser history path.
  // Send its release without a pointer-down: a fresh page activation would
  // clear history-skipping flags and hide the system-Back regression.
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "back", buttons: 0, x: 0, y: 0 });
}
async function hint(cdp: CDPSession) {
  await expect.poll(async () => (await state(cdp)).text).toBe("Press back again to exit");
}
async function visible(cdp: CDPSession, value: "visible" | "hidden") {
  await passive(cdp, `Object.defineProperty(document, 'visibilityState', { configurable: true, value: '${value}' });
    document.dispatchEvent(new Event('visibilitychange'));`);
}

test("cold launches accept the first native close request without page activation", async ({ context }) => {
  await standalone(context);
  for (let cycle = 0; cycle < 3; cycle++) {
    const { page, cdp } = await launch(context);
    const entries = (await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id);
    await closeRequest(cdp);
    await hint(cdp);
    expect(await state(cdp)).toMatchObject({ active: false, guard: "floor", index: 0, length: 2 });
    // No watcher remains to intercept the second native close request. Desktop
    // Escape cannot close an Android app window; verify the exposed exit boundary.
    await closeRequest(cdp);
    expect(await state(cdp)).toMatchObject({ active: false, guard: "floor", index: 0, length: 2 });
    expect((await cdp.send("Page.getNavigationHistory")).entries.map(entry => entry.id)).toEqual(entries);
    await page.close();
  }
});

test("the native exit deadline resets without intervening page activation", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  await closeRequest(cdp);
  await hint(cdp);
  await expect.poll(async () => (await state(cdp)).guard).toBe("app");
  await expect.poll(async () => (await state(cdp)).text).toBe("");
  expect((await state(cdp)).active).toBe(false);
  await closeRequest(cdp);
  await hint(cdp);
  expect((await state(cdp)).active).toBe(false);
  await page.close();
});

test("warm returns reset the native close watcher and keep history bounded", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  for (let cycle = 0; cycle < 3; cycle++) {
    await closeRequest(cdp);
    await hint(cdp);
    await visible(cdp, "hidden");
    await visible(cdp, "visible");
    await expect.poll(async () => (await state(cdp)).guard).toBe("app");
    await expect.poll(async () => (await state(cdp)).text).toBe("");
    expect(await state(cdp)).toMatchObject({ active: false, length: 2 });
  }
  await closeRequest(cdp);
  await hint(cdp);
  await page.close();
});

test("restoring only the current history entry cannot wedge native exit or navigation", async ({ context }) => {
  await standalone(context, true);
  const { page, cdp } = await launch(context);
  expect((await state(cdp)).length).toBe(1);
  await closeRequest(cdp);
  await hint(cdp);
  expect(await state(cdp)).toMatchObject({ active: false, index: 0, length: 1 });
  await expect.poll(async () => (await state(cdp)).text).toBe("");
  await closeRequest(cdp);
  await hint(cdp);
  await page.getByText("Wire the web QA harness", { exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await page.close();
});

test("page and layer navigation take priority over the native root exit watcher", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await closeRequest(cdp);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await state(cdp)).text).toBe("");
  await page.getByText("Wire the web QA harness", { exact: true }).click();
  await closeRequest(cdp);
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
  expect((await state(cdp)).text).toBe("");
  await page.evaluate(() => history.back());
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await closeRequest(cdp);
  await hint(cdp);
  await page.close();
});

test("dismissing the native hint immediately restores the first-Back condition", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  await closeRequest(cdp);
  await hint(cdp);
  await page.getByTestId("toast").focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await state(cdp)).guard).toBe("app");
  await expect.poll(async () => (await state(cdp)).text).toBe("");
  await closeRequest(cdp);
  await hint(cdp);
  await page.close();
});

for (const reload of [false, true]) {
  test(`checking updates retains native exit after nested Settings Back${reload ? " and checkpoint reload" : ""}`, async ({ context }) => {
    await standalone(context);
    const { page, cdp } = await launch(context);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Updates", exact: true }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/api/settings/updates")
        && response.request().method() === "POST" && response.request().postDataJSON().action === "check"),
      page.getByRole("button", { name: "Check again", exact: true }).click(),
    ]);
    if (reload) {
      // Model the screen checkpoint written before an automatic update reload.
      await page.evaluate(async () => {
        const id = "settings-back-update";
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("palmagent-screen-state", 1);
          request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("checkpoints", "readwrite");
            tx.objectStore("checkpoints").put({ route: location.hash, created: Date.now(),
              values: { "settings:open": true, "settings:section": "updates" }, screen: { scroll: [] } }, id);
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
          };
        });
        sessionStorage.setItem("palmagent:screen-checkpoint", id);
      });
      await cdp.send("Page.enable");
      const loaded = new Promise<void>(resolve => cdp.once("Page.loadEventFired", () => resolve()));
      await cdp.send("Page.reload");
      await loaded;
    }
    const dialog = () => passive(cdp, `document.querySelector('[role="dialog"][data-state="open"] h2')?.textContent ?? ''`);
    await expect.poll(dialog).toBe("Updates");
    const before = await cdp.send("Page.getNavigationHistory");
    // From here until the exit hint, use only passive reads and browser Back.
    // JavaScript history.back() and page interaction bypass the original bug.
    await browserBack(cdp);
    await expect.poll(dialog).toBe("Settings");
    await expect.poll(async () => (await cdp.send("Page.getNavigationHistory")).currentIndex).toBe(before.currentIndex);
    await browserBack(cdp);
    await expect.poll(async () => (await state(cdp)).guard).toBe("app");
    await expect.poll(() => passive(cdp, `document.querySelectorAll('[role="dialog"]').length`)).toBe(0);
    await closeRequest(cdp);
    await hint(cdp);
    await expect.poll(async () => (await state(cdp)).guard).toBe("app");
    await expect.poll(async () => (await state(cdp)).text).toBe("");
    await closeRequest(cdp);
    await hint(cdp);
    await closeRequest(cdp);
    expect((await state(cdp)).guard).toBe("floor");
    await page.close();
  });
}

test("reloading the exposed legacy floor retains native exit without activation", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  await cdp.send("Page.enable");
  for (let cycle = 0; cycle < 2; cycle++) {
    await closeRequest(cdp);
    await hint(cdp);
    const loaded = new Promise<void>(resolve => cdp.once("Page.loadEventFired", () => resolve()));
    await cdp.send("Page.reload");
    await loaded;
    await expect.poll(async () => (await state(cdp)).ready).toBe(true);
    expect(await state(cdp)).toMatchObject({ active: false, guard: "app", length: 2 });
  }
  await closeRequest(cdp);
  await hint(cdp);
  await page.close();
});

test("returning after Forward history is discarded rebuilds the missing guard", async ({ context }) => {
  await standalone(context);
  const { page, cdp } = await launch(context);
  await closeRequest(cdp);
  await hint(cdp);
  await visible(cdp, "hidden");
  await cdp.send("Page.resetNavigationHistory");
  expect((await state(cdp)).length).toBe(1);
  await visible(cdp, "visible");
  await expect.poll(async () => (await state(cdp)).guard).toBe("app");
  expect(await state(cdp)).toMatchObject({ active: false, length: 2 });
  await closeRequest(cdp);
  await hint(cdp);
  expect(await state(cdp)).toMatchObject({ active: false, guard: "floor", index: 0 });
  await page.getByText("Wire the web QA harness", { exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
  await page.close();
});
