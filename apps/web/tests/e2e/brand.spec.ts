import { test, expect, type Locator } from "@playwright/test";
import brand from "../../src/brand.json" with { type: "json" };

test.use({ serviceWorkers: "block" });

function rgb(hex: string): string {
  return `rgb(${hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16)).join(", ")})`;
}

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
  test(`${theme} brand applies to actions, selection, and browser chrome`, async ({ page }) => {
    // Choose the opposite OS scheme to catch manual-theme overrides drifting.
    await page.emulateMedia({ colorScheme: theme === "light" ? "dark" : "light" });
    await page.goto(`/?__theme=${theme}`);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[theme].chrome);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    const primary = page.getByRole("dialog").getByRole("button", { name: "New task", exact: true });
    await expect(primary).toHaveCSS("background-color", rgb(brand[theme].primary));
    await expect(primary).toHaveCSS("color", rgb(brand[theme]["primary-foreground"]));
    await expectReadable(primary);
    const selected = page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name: "Tasks", exact: true });
    await expect(selected).toHaveCSS("background-color", rgb(brand[theme].accent));
    await expectReadable(selected);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const tab = page.getByRole("tab", { name: "General", exact: true });
    await expect(tab).toHaveCSS("color", rgb(brand[theme]["accent-foreground"]));
    await expectReadable(tab);
    await expect(page).toHaveScreenshot(`brand-settings-${theme}.png`);
    const next = theme === "light" ? "dark" : "light";
    await page.getByRole("radio", { name: `${next === "light" ? "Light" : "Dark"} theme` }).click();
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[next].chrome);
    await expect(tab).toHaveCSS("background-color", rgb(brand[next].accent));
    await page.reload();
    // The query override still wins on reload.
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand[theme].chrome);
  });

  test(`${theme} sign-in uses readable primary actions`, async ({ page }) => {
    await page.route("**/api/auth/me", route => route.fulfill({ json: { required: true, authenticated: false } }));
    await page.goto(`/?__theme=${theme}`);
    const button = page.getByRole("button", { name: "Sign in with passkey" });
    await expect(button).toHaveCSS("background-color", rgb(brand[theme].primary));
    await expectReadable(button);
    await expect(page).toHaveScreenshot(`brand-sign-in-${theme}.png`);
  });
}

test("installed assets and manifest share the brand palette", async ({ page, request }) => {
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.theme_color).toBe(brand.light.chrome);
  expect(manifest.background_color).toBe(brand.light.chrome);
  const favicon = await (await request.get("/favicon.svg")).text();
  expect(favicon).toContain(`fill="${brand.light.primary}"`);
  const logo = await (await request.get("/logo.svg")).text();
  expect(logo).toContain(brand.light.primary);
  expect(logo).toContain(brand.dark.primary);
  await page.goto("/");
  for (const asset of ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
    const pixel = await page.evaluate(async name => {
      const image = new Image();
      image.src = `/${name}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = image.naturalWidth;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return Array.from(ctx.getImageData(Math.floor(canvas.width / 2), 4, 1, 1).data).slice(0, 3);
    }, asset);
    expect(`rgb(${pixel.join(", ")})`, asset).toBe(rgb(brand.light.primary));
  }
});

test("system theme changes keep browser chrome in sync", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand.light.chrome);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", brand.dark.chrome);
});
