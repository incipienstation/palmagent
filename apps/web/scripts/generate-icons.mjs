import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

import brand from '../src/brand.json' with { type: 'json' };

// Geometry and palette are authored once; every public brand asset is generated.
const publicDir = new URL('../public/', import.meta.url);
const source = await readFile(new URL('../src/assets/palm.svg', import.meta.url), 'utf8');
const geometry = source.match(/<g[\s\S]*<\/g>/)?.[0];
if (!geometry) throw new Error('Expected the palm foreground group');
const mark = geometry.replace('currentColor', brand.light['primary-foreground']);
const background = `<rect width="64" height="64" rx="14" fill="${brand.light.primary}"/>`;
const fullBleed = background.replace(' rx="14"', '');
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PalmAgent">
  ${background}
  ${mark}
</svg>\n`;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PalmAgent">
  <style>:root { color: ${brand.light.primary}; } @media (prefers-color-scheme: dark) { :root { color: ${brand.dark.primary}; } }</style>
  ${geometry}
</svg>\n`;
await writeFile(new URL('favicon.svg', publicDir), favicon);
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
console.log('Generated logo and app icons from palm.svg and brand.json');
