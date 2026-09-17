import { expect, type Page } from "@playwright/test";
export { installScopedStream, send, event, open, type Harness } from "./_scoped-stream";

export const viewport = (page: Page) => page.locator("[data-radix-scroll-area-viewport]").first();
export async function expectBottom(page: Page) {
  // Virtuoso hides the list while its initial scroll target is still settling.
  // A zero bottom gap during that phase does not mean a reader can interact yet.
  await expect(viewport(page).getByTestId("virtuoso-item-list")).toBeVisible();
  // Variable-height virtualization settles measurements across animation frames.
  // Require a stable bottom before simulating the next user interaction.
  await expect.poll(() => viewport(page).evaluate(async (el) => {
    let largestGap = 0;
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      largestGap = Math.max(largestGap, el.scrollHeight - el.clientHeight - el.scrollTop);
    }
    return largestGap;
  })).toBeLessThanOrEqual(2);
}
