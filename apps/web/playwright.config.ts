import { defineConfig } from "@playwright/test";
import { readdirSync } from "node:fs";

// Galaxy S25 (model SM-S931B): 1080×2340 physical @ DPR 3 → 360×780 CSS, Android
// 15. Playwright ships no built-in S25 descriptor, so pin the device explicitly.
// 360 CSS px is narrower than most phones, so it's a strict horizontal-overflow
// stress test — the mobile baseline this app is designed for.
const galaxyS25 = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  defaultBrowserType: "chromium",
} as const;

// Headless, isolated, mobile-first E2E harness for the PWA. It runs the built
// app (apps/web/dist) against the hermetic mock backend (tests/mock-server.mjs)
// — no real dispatcher, no claude/codex CLI — so the layout/visual regressions
// we keep reintroducing (ScrollArea overflow, viewport scroll-lock, banner/FAB
// overlap) are caught before they ship. The web-side analog of the server's
// self-contained server runtime smoke.
//
//   pnpm --filter @palmagent/web test:e2e            # build + run
//   pnpm --filter @palmagent/web test:e2e:update     # refresh baselines
//
// Snapshot baselines live next to each spec in <spec>.ts-snapshots/ and ARE
// committed — that committed image IS the regression contract. Regenerate them
// (test:e2e:update) only when a UI change is intentional, and eyeball the diff.

const PORT = Number(process.env.E2E_PORT ?? 4317);
const baseURL = `http://localhost:${PORT}`;
const specs = readdirSync(new URL("./tests/e2e/", import.meta.url), { recursive: true })
  .filter((file) => /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file)).sort();
const groups = [0, 1];

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Rename tests mutate the mock backend. Give each concurrent group its own
  // server, and run that group's tests sequentially, including cleanup hooks.
  workers: 2,
  projects: groups.map((group) => ({
    name: `group-${group + 1}`,
    workers: 1,
    testMatch: specs.filter((_, index) => index % groups.length === group).map((file) => `**/${file}`),
    use: { baseURL: `http://localhost:${PORT + group}` },
  })),
  // Group assignment is scheduling only; preserve the existing visual baselines.
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{-platform}{ext}",
  reporter: [["list"]],
  // Galaxy S25 fixes the viewport (360×780), DPR, touch and UA so renders are
  // reproducible run to run (see galaxyS25 above).
  expect: {
    toHaveScreenshot: {
      // Absorb sub-pixel font anti-aliasing jitter while still failing on real
      // layout shifts. Baselines are generated on this host, so keep it tight.
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
    },
  },
  use: {
    baseURL,
    // The app is dual-theme (default `system`); emulate a dark OS preference so
    // the harness renders the dark theme deterministically for stable baselines.
    // (Per-test light-mode checks use the ?__theme=light query hook.)
    colorScheme: "dark",
    ...galaxyS25,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  // The calling verification command builds the PWA before starting these servers.
  webServer: groups.map((group) => ({
    command: "node tests/mock-server.mjs",
    url: `http://localhost:${PORT + group}`,
    env: { PORT: String(PORT + group) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  })),
});
