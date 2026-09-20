import { test, expect, type Locator } from "@playwright/test";
import brand from "../../src/brand.json" with { type: "json" };

test.use({ serviceWorkers: "block" });

async function expectReadable(control: Locator): Promise<void> {
  const ratio = await control.evaluate(element => {
    const style = getComputedStyle(element);
    const luminance = (color: string) => {
      const [r, g, b] = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = luminance(style.color), b = luminance(style.backgroundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
  expect(ratio, "text contrast on the rendered brand surface").toBeGreaterThanOrEqual(4.5);
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} controls stay readable and browser chrome follows the selected theme`, async ({ page }) => {
    // Choose the opposite OS scheme to catch manual-theme overrides drifting.
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.goto(`/?__theme=${theme}`);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[theme].chrome);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const primary = page.getByRole("dialog").getByRole("button", { name: "New task", exact: true });
    await expectReadable(primary);
    const selected = page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Tasks", exact: true });
    await expectReadable(selected);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const selection = page.getByRole("radio", { name: "Default output", exact: true });
    await expectReadable(selection);
    const next = theme === "light" ? "dark" : "light";
    await page.getByRole("radio", { name: `${next === "light" ? "Light" : "Dark"} theme` }).click();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[next].chrome);
    await page.reload();
    // The query override still wins on reload.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[theme].chrome);
  });

  test(`${theme} sign-in uses readable primary actions`, async ({ page }) => {
    await page.route("**/api/auth/me", route => route.fulfill({ json: { required: true, authenticated: false } }));
    await page.goto(`/?__theme=${theme}`);
    const button = page.getByRole("button", { name: "Sign in with passkey" });
    await expectReadable(button);
  });
}

test("installed assets decode and the manifest follows the configured theme", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.theme_color).toBe(brand.light.chrome);
  expect(manifest.background_color).toBe(brand.light.chrome);
  await page.goto("/");
  await page.evaluate(async () => {
    for (const asset of ["favicon.svg", "logo.svg", "icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
      const image = new Image();
      image.src = `/${asset}`;
      await image.decode();
    }
  });
});

test("system theme changes keep browser chrome in sync", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand.light.chrome);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand.dark.chrome);
});
