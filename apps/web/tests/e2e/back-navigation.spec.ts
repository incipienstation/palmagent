import { test, expect, type Page } from "@playwright/test";

const task = "#/task/t-idle-rich";
async function standalone(page: Page) {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = query => {
      const result = original(query);
      if (query.includes("display-mode: standalone")) Object.defineProperty(result, "matches", { value: true });
      return result;
    };
  });
}
async function back(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    history.back();
  }));
}
async function forward(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => {
    window.addEventListener("popstate", () => resolve(), { once: true });
    history.forward();
  }));
}
async function pageEntry(page: Page) {
  await expect.poll(() => page.evaluate(() => history.state?.__palmagentNavigation?.kind)).toBe("page");
}
async function layerEntry(page: Page) {
  await expect.poll(() => page.evaluate(() => history.state?.__palmagentNavigation?.kind)).toBe("layer");
}
async function openTask(page: Page) {
  await page.goto("/");
  await page.getByText("Wire the web QA harness", { exact: true }).click();
  await expect(page).toHaveURL(/#\/task\/t-idle-rich$/);
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await layerEntry(page);
}

for (const installed of [false, true]) {
  test.describe(installed ? "installed navigation" : "browser navigation", () => {
    test.beforeEach(async ({ page }) => { if (installed) await standalone(page); });

    test("Back unwinds settings subpage, sheet, then page; Forward restores the page", async ({ page }) => {
      await openTask(page);
      await settings(page);
      await page.getByRole("button", { name: "Updates", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Updates", exact: true })).toBeVisible();
      await back(page);
      await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(task + "$"));
      await layerEntry(page);
      await back(page);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await pageEntry(page);
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
      await back(page);
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
      await pageEntry(page);
      await forward(page);
      await expect(page).toHaveURL(new RegExp(task + "$"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("reloads preserve real page history without growing it", async ({ page }) => {
      await openTask(page);
      const length = await page.evaluate(() => history.length);
      for (let i = 0; i < 2; i++) {
        await page.reload();
        await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
        expect(await page.evaluate(() => history.length)).toBe(length);
      }
      await back(page);
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
      await expect(page.getByText("Press back again to exit", { exact: true })).toHaveCount(0);
    });

    test("direct task link has an in-app return to Tasks", async ({ page }) => {
      await page.goto("/" + task);
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Tasks", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
      await expect(page.getByText("Press back again to exit", { exact: true })).toHaveCount(0);
    });

    test("reloading an open drawer leaves the conversation navigable", async ({ page }) => {
      await openTask(page);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await layerEntry(page);
      await page.reload();
      await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
      await pageEntry(page);
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await page.getByRole("button", { name: "Tasks", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    });

    test("drawer navigation cleans up its cover and preserves page Back/Forward", async ({ page }) => {
      await openTask(page);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.getByRole("button", { name: "Usage", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
      await pageEntry(page);
      await back(page);
      await expect(page).toHaveURL(new RegExp(task + "$"));
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await forward(page);
      await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
    });
  });
}

test("repeated Escape and close actions leave no extra Back steps", async ({ page }) => {
  await openTask(page);
  for (let i = 0; i < 3; i++) {
    await settings(page);
    if (i % 2) await page.getByRole("button", { name: "Close settings" }).click();
    else await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await pageEntry(page);
  }
  await back(page);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("Back cancels a nested destructive confirmation without running its action", async ({ page }) => {
  let signouts = 0;
  page.on("request", request => { if (request.url().includes("/logout")) signouts++; });
  await openTask(page);
  await settings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await back(page);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(task + "$"));
  expect(signouts).toBe(0);
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Back closes an embedded terminal before leaving the conversation", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Task actions" }).click();
  await page.getByRole("menuitem", { name: "Open terminal" }).click();
  await expect(page.getByRole("button", { name: "Back to conversation" })).toBeVisible();
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("button", { name: "Back to conversation" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(task + "$"));
  await pageEntry(page);
  await back(page);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("Back dismisses selectors and action menus without changing the page", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/new$/);
  await pageEntry(page);
  await page.goto("/" + task);
  await page.getByRole("button", { name: "Task actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(task + "$"));
});

test("Forward does not resurrect a dismissed overlay", async ({ page }) => {
  await openTask(page);
  await settings(page);
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pageEntry(page);
  await forward(page);
  await pageEntry(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await back(page);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("root exit protection runs only after all visible layers close", async ({ page }) => {
  await standalone(page);
  await page.goto("/");
  await settings(page);
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pageEntry(page);
  await expect(page.getByText("Press back again to exit", { exact: true })).toHaveCount(0);
  await back(page);
  await expect(page.getByText("Press back again to exit", { exact: true })).toBeVisible();
});

test("repo picker Back retraces folders, returns to search, then closes", async ({ page }) => {
  await page.goto("/#/new");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("option", { name: "Browse folders…" }).click();
  await expect(page.getByText("/projects", { exact: true })).toBeVisible();
  await page.getByRole("option", { name: /outer-repo/ }).click();
  await page.getByRole("option", { name: /nested-tools/ }).click();
  await expect(page.getByText("/projects/outer-repo/nested-tools", { exact: true }).first()).toBeVisible();
  await back(page);
  await expect(page.getByRole("option", { name: /nested-tools/ })).toBeVisible();
  await back(page);
  await expect(page.getByText("/projects", { exact: true })).toBeVisible();
  await back(page);
  await expect(page.getByRole("option", { name: "Browse folders…" })).toBeVisible();
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/#\/new$/);
});

test("Back dismisses the delivery popover and preserves the message draft", async ({ page }) => {
  await openTask(page);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep my unsent message");
  await page.getByRole("button", { name: "Send now", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("dialog", { name: "Message delivery", exact: true })).toBeVisible();
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(draft).toHaveValue("Keep my unsent message");
  await expect(page).toHaveURL(new RegExp(task + "$"));
});

for (const installed of [false, true]) {
  test(`${installed ? "installed double" : "native browser"} Back can leave from the root`, async ({ page }) => {
    await page.route("**/outside", route => route.fulfill({ contentType: "text/html", body: "<h1>Outside</h1>" }));
    await page.goto("/outside");
    if (installed) await standalone(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    if (installed) {
      await back(page);
      await expect(page.getByText("Press back again to exit", { exact: true })).toBeVisible();
    }
    await page.evaluate(() => history.back());
    await expect(page.getByRole("heading", { name: "Outside", exact: true })).toBeVisible();
  });
}

test("selecting the current destination closes navigation without a duplicate page", async ({ page }) => {
  await openTask(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("button", { name: "Wire the web QA harness", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await pageEntry(page);
  await back(page);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});

test("native hash navigation dismisses overlays and skips obsolete entries in both directions", async ({ page }) => {
  await openTask(page);
  await settings(page);
  await page.evaluate(() => { location.hash = "/usage"; });
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await back(page);
  await expect(page).toHaveURL(new RegExp(task + "$"));
  await pageEntry(page);
  await expect(page.getByRole("heading", { name: /Wire the web QA harness/ })).toBeVisible();
  await page.reload();
  await pageEntry(page);
  await forward(page);
  await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const reopen of [false, true]) {
  test(`late dispatch success respects Back${reopen ? " and a reopened form" : ""}`, async ({ page }) => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let requested = false;
    await page.route("**/api/tasks", async route => {
      if (route.request().method() !== "POST") return route.continue();
      requested = true;
      await pending;
      await route.fulfill({ status: 201, json: { task: { taskId: "t-idle-rich" } } });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Dispatch new task", exact: true }).click();
    await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("Submitted draft");
    await page.getByRole("button", { name: "Dispatch", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    if (reopen) {
      await page.getByRole("button", { name: "Dispatch new task", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeDisabled();
    }
    release();
    await expect(page.getByTestId("toast").filter({ hasText: "Dispatched" })).toBeVisible();
    if (reopen) {
      await expect(page.getByRole("heading", { name: "New task", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
      await page.getByRole("textbox", { name: "Prompt", exact: true }).fill("My next task draft");
      await page.reload();
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("My next task draft");
    } else {
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Dispatch new task", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toHaveValue("");
    }
  });
}

test("an update checkpoint from a hashless root restores its settings subpage", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  // Model the previous client's URL/history and its existing update checkpoint.
  await page.evaluate(async () => {
    history.replaceState(null, "", location.pathname);
    const id = "navigation-upgrade-test";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("palmagent-screen-state", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("checkpoints");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("checkpoints", "readwrite");
        transaction.objectStore("checkpoints").put({ route: "", created: Date.now(),
          values: { "settings:open": true, "settings:section": "updates" }, screen: { scroll: [] } }, id);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
    sessionStorage.setItem("palmagent:screen-checkpoint", id);
  });
  await page.reload();
  await expect(page.getByRole("dialog", { name: "Updates", exact: true })).toBeVisible();
  await layerEntry(page);
  await back(page);
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible();
  await back(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
});
