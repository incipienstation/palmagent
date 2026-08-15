import { expect, type Page } from "@playwright/test";

// The load-bearing mobile-layout invariant this whole app is built around
// (index.css): the *document* must never scroll — only the inner overflow panes
// do — and nothing may widen it past the viewport. Asserting it on every view
// catches the recurring class of regressions directly:
//   - horizontal overflow from long content inside Radix ScrollArea
//   - document vertical scroll from a broken dynamic-viewport lock
export async function assertViewportLocked(page: Page): Promise<void> {
  const { hOverflow, vSlack } = await page.evaluate(() => {
    const d = document.documentElement;
    const s = document.scrollingElement ?? d;
    return { hOverflow: d.scrollWidth - d.clientWidth, vSlack: s.scrollHeight - s.clientHeight };
  });
  // ≤1px absorbs sub-pixel dvh rounding; anything more is a real overflow.
  expect(hOverflow, "document overflows horizontally — content is wider than the viewport").toBeLessThanOrEqual(1);
  expect(
    vSlack,
    "document scrolls vertically — the viewport lock is broken (only inner panes should scroll)",
  ).toBeLessThanOrEqual(1);
}
