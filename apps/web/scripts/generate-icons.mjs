import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// favicon.svg owns the palm geometry and app-icon colors. Render derived assets
// with the same Chromium used by web tests: pnpm --filter @palmagent/web icons:generate.
const publicDir = new URL('../public/', import.meta.url);
const favicon = await readFile(new URL('favicon.svg', publicDir), 'utf8');
const background = favicon.match(/<rect[^>]*width="64"[^>]*\/>/)?.[0];
const mark = favicon.match(/<g[\s\S]*<\/g>/)?.[0];
if (!background || !mark) throw new Error('Expected the favicon background and palm group');
const fullBleed = background.replace(' rx="14"', '');
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PalmAgent">
  <style>:root { color: #202020; } @media (prefers-color-scheme: dark) { :root { color: #f5f5f5; } }</style>
  ${mark.replace('fill="#ffffff"', 'fill="currentColor"')}
</svg>\n`;
await writeFile(new URL('logo.svg', publicDir), logo);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const [name, size, body] of [
    ['icon-192.png', 192, background + mark],
    ['icon-512.png', 512, background + mark],
    ['apple-touch-icon.png', 180, fullBleed + mark],
    // The 70% mark fits inside Android's circular 80% maskable safe zone.
    ['icon-512-maskable.png', 512, fullBleed + `<g transform="translate(9.6 9.6) scale(0.7)">${mark}</g>`],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body { margin:0; } svg { display:block; width:100vw; height:100vh; }</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`);
    await page.screenshot({ path: fileURLToPath(new URL(name, publicDir)), omitBackground: true });
  }
} finally {
  await browser.close();
}
console.log('Generated monochrome logo and app icons from favicon.svg');
