// Render the existing vector logo's foreground as an Android notification mask.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const assets = new URL("../public/", import.meta.url);
const svg = await readFile(new URL("favicon.svg", assets), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const png = await page.evaluate(async (source) => {
    const logo = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
    // Keep only the foreground group; the rounded background must stay transparent.
    const foreground = logo.querySelector(":scope > g");
    if (!foreground) throw new Error("favicon.svg must contain a foreground group");
    logo.replaceChildren(foreground);
    logo.setAttribute("width", "96");
    logo.setAttribute("height", "96");
    const blob = new Blob([new XMLSerializer().serializeToString(logo)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      canvas.getContext("2d").drawImage(image, 0, 0, 96, 96);
      return canvas.toDataURL("image/png").split(",")[1];
    } finally {
      URL.revokeObjectURL(url);
    }
  }, svg);
  assert(png, "badge rendering must produce PNG bytes");
  await writeFile(new URL("notification-badge.png", assets), Buffer.from(png, "base64"));
} finally {
  await browser.close();
}
