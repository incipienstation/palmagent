// Reusable live browser-QA driver — the geometry-asserting half of the
// `browser-qa` skill, the companion to the snapshot-asserting Playwright suite.
//
// WHY THIS EXISTS: a DOM "is it open?" boolean LIES. A Radix Popper menu can be
// `data-state="open"`, opacity 1, `isVisible()===true` — and still be painted
// 260px ABOVE the viewport (floating-ui never positioned it; its wrapper is stuck
// at the `translate(0,-200%)` "unpositioned" sentinel). A human glancing at a
// small screenshot reads that as "closed/nothing happened". This driver makes the
// failure measurable: for every overlay the change opens it asserts the thing is
// actually ON SCREEN and HITTABLE, and saves a screenshot for you to `Read`.
// (This is exactly the class that shipped the offscreen kebab menu — see the
// browser-qa skill.)
//
// It is self-contained: it boots its own mock server
// against the built dist/, drives a real Galaxy S25 device with real touch taps,
// and tears everything down. No separately-running server needed.
//
// Usage (build dist first — it serves what ships, not source):
//   pnpm --filter @palmagent/web build
//   node tests/browser-qa.mjs --route '/#/task/t-run' \
//        --tap 'button[aria-label="Task actions"]' \
//        [--tap '<next trigger>' ...] [--out /tmp/browser-qa] [--port 4399]
//
// Each --tap is a trigger selector: the driver taps it, then asserts whichever
// overlay opened (Radix popper / role=menu|dialog|listbox) is in-viewport +
// hittable, screenshots the state, and dismisses it before the next tap. It also
// screenshots the base route. Exit code is non-zero if ANY assertion fails — wire
// it into a gate — but ALWAYS inspect the screenshots too; geometry proves it is
// on screen, only your eyes prove it looks right.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Galaxy S25 (SM-S931B) — kept in sync with apps/web/playwright.config.ts. 360 CSS
// px is the narrow mobile baseline this app is designed for; real touch + isMobile
// so taps and layout match a phone, not a desktop mouse.
const galaxyS25 = {
  userAgent:
    "Mozilla/5.0 (Linux; Android 15; SM-S931B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  viewport: { width: 360, height: 780 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

function parseArgs(argv) {
  const out = { route: "/#/", taps: [], out: "/tmp/browser-qa", port: 4399, height: 780, theme: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--route") out.route = argv[++i];
    else if (a === "--tap") out.taps.push(argv[++i]);
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--height") out.height = Number(argv[++i]);
    else if (a === "--theme") out.theme = argv[++i]; // 'light' | 'dark'
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!Number.isInteger(out.height) || out.height < 320) throw new Error("--height must be an integer of at least 320");
  return out;
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// The overlay kinds we know how to find (Radix poppers/menus/listboxes, vaul
// sheets via role=dialog, our dropdown slot). Shared by the settle-wait and the
// geometry inspector so they always agree on "which element is the overlay".
const OVERLAY_SELS = [
  "[data-radix-popper-content-wrapper]",
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  "[data-slot='dropdown-menu-content']",
  "[data-radix-select-viewport]",
];

// Runs INSIDE the page. Finds the topmost open overlay and reports whether it is
// genuinely on screen and hittable — the assertions a DOM `isVisible()` skips.
function inspectOverlay(sels) {
  let el = null;
  for (const s of sels) {
    const found = [...document.querySelectorAll(s)].filter((n) => {
      const cs = getComputedStyle(n);
      return cs.display !== "none" && cs.visibility !== "hidden";
    });
    if (found.length) {
      el = found[found.length - 1];
      break;
    }
  }
  if (!el) return { found: false };
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  // The Radix popper wrapper parks unpositioned content at translate(_, -200%) —
  // a `%` transform is the dead giveaway floating-ui never measured it.
  const wrap = el.closest("[data-radix-popper-content-wrapper]") || el;
  const wt = wrap.getAttribute && wrap.getAttribute("style")?.match(/transform:\s*([^;]+)/)?.[1];
  const popperUnpositioned = wt ? wt.includes("%") : false;
  const cx = r.x + r.width / 2;
  const cy = r.y + Math.min(24, r.height / 2); // near the top edge of the overlay
  const hit = document.elementFromPoint(cx, cy);
  const hittable = !!hit && (el.contains(hit) || hit.contains(el));
  const inViewport = r.width > 0 && r.height > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
  return {
    found: true,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { w: innerWidth, h: innerHeight },
    opacity: cs.opacity,
    popperTransform: wt || null,
    popperUnpositioned,
    inViewport,
    hittable,
    hitTag: hit ? hit.getAttribute("data-slot") || hit.tagName : null,
  };
}

// Wait for the topmost overlay to stop moving before we measure it. A flat sleep
// races animated overlays — vaul's drawer slides up over ~500ms, so a too-early
// read catches it a few px low and reports a false offscreen FAIL. Poll the rect
// across frames and return once it's been stable for a few frames (or time out,
// e.g. when no overlay ever opens — the inspector then reports "not found").
async function waitForOverlaySettled(page, sels, maxMs = 2000) {
  await page.evaluate(
    async ({ sels, maxMs }) => {
      const find = () => {
        for (const s of sels) {
          const f = [...document.querySelectorAll(s)].filter((n) => {
            const cs = getComputedStyle(n);
            return cs.display !== "none" && cs.visibility !== "hidden";
          });
          if (f.length) return f[f.length - 1];
        }
        return null;
      };
      const start = performance.now();
      let prev = "";
      let stable = 0;
      while (performance.now() - start < maxMs) {
        const el = find();
        const r = el && el.getBoundingClientRect();
        const key = r ? `${Math.round(r.y)}:${Math.round(r.bottom)}` : "none";
        if (key !== "none" && key === prev) {
          if (++stable >= 3) return; // settled
        } else {
          stable = 0;
          prev = key;
        }
        await new Promise((res) => requestAnimationFrame(() => res()));
      }
    },
    { sels, maxMs },
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const distDir = join(__dirname, "..", "dist");
  if (!existsSync(join(distDir, "index.html"))) {
    console.error("[browser-qa] apps/web/dist is missing — run `pnpm --filter @palmagent/web build` first.");
    process.exit(2);
  }
  mkdirSync(args.out, { recursive: true });

  // 1. Boot the hermetic mock server against the built dist.
  const mock = spawn("node", [join(__dirname, "mock-server.mjs")], {
    env: { ...process.env, PORT: String(args.port) },
    stdio: "ignore",
  });
  const base = `http://localhost:${args.port}`;
  if (!(await waitForServer(`${base}/api/tasks`))) {
    mock.kill("SIGKILL");
    console.error(`[browser-qa] mock server never came up on :${args.port}`);
    process.exit(2);
  }

  const results = [];
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const device = { ...galaxyS25, viewport: { ...galaxyS25.viewport, height: args.height } };
    const ctx = await browser.newContext({ ...device, colorScheme: args.theme === "light" ? "light" : "dark" });
    const page = await ctx.newPage();
    const url = base + args.route + (args.theme ? (args.route.includes("?") ? "&" : "?") + `__theme=${args.theme}` : "");
    await page.goto(url);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);

    const shot = async (name) => {
      const p = join(args.out, `${name}.png`);
      await page.screenshot({ path: p });
      return p;
    };
    console.log(`[browser-qa] route ${args.route} @ ${device.viewport.width}x${device.viewport.height} (S25, touch)`);
    console.log(`  base screenshot: ${await shot("00-base")}`);

    let i = 0;
    for (const sel of args.taps) {
      i++;
      const label = `${String(i).padStart(2, "0")}-tap`;
      const trigger = page.locator(sel).first();
      if ((await trigger.count()) === 0) {
        results.push({ sel, ok: false, reason: "trigger selector not found" });
        console.log(`  FAIL  ${sel} — trigger not found`);
        continue;
      }
      await trigger.tap();
      await waitForOverlaySettled(page, OVERLAY_SELS);
      const info = await page.evaluate(inspectOverlay, OVERLAY_SELS);
      const ssPath = await shot(label);
      let ok = info.found && info.inViewport && info.hittable && !info.popperUnpositioned;
      const reason = !info.found
        ? "no overlay opened after tap"
        : info.popperUnpositioned
          ? `popper never positioned (transform ${info.popperTransform}) — content is OFFSCREEN`
          : !info.inViewport
            ? `overlay rect ${JSON.stringify(info.rect)} is outside the ${info.viewport.w}x${info.viewport.h} viewport`
            : !info.hittable
              ? "overlay center is not hittable (covered or offscreen)"
              : "ok";
      results.push({ sel, ok, reason, info, screenshot: ssPath });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${sel} — ${reason}`);
      console.log(`        screenshot: ${ssPath}  (inspect it — geometry passing is necessary, not sufficient)`);
      // dismiss before the next trigger
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200);
    }
    await ctx.close();
  } finally {
    await browser.close();
    mock.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[browser-qa] ${results.length - failed.length}/${results.length} overlay checks on screen. ${failed.length ? "FAILED" : "OK"}`);
  console.log("[browser-qa] now inspect every screenshot above — geometry can't tell you it LOOKS right.");
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("[browser-qa] crashed:", e);
  process.exit(2);
});
