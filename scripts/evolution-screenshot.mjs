#!/usr/bin/env node
/**
 * Evolution UI preview screenshot runner (opt-in, Playwright-backed).
 *
 * Playwright is NOT a dependency of IM.codes — install it yourself
 * (`npm i -D playwright && npx playwright install chromium`) and wire this
 * script through `.imc/evolution/design.json`:
 *
 *   {
 *     "screenshot": {
 *       "enabled": true,
 *       "command": "node",
 *       "args": [
 *         "scripts/evolution-screenshot.mjs",
 *         "{previewPath}", "{outputPath}", "{width}", "{height}", "{screenAnchor}"
 *       ]
 *     }
 *   }
 *
 * Honest failure contract: when Playwright is missing, the preview file is
 * absent, or rendering fails, this exits non-zero WITHOUT writing an output
 * file — the pipeline then records the screenshot capability as `failed`
 * instead of pretending a rendered screenshot exists.
 */
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [previewPath, outputPath, widthArg, heightArg, anchorArg] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`evolution-screenshot: ${message}\n`);
  process.exit(1);
}

if (!previewPath || !outputPath) {
  fail('usage: evolution-screenshot.mjs <previewPath> <outputPath> [width] [height] [anchor]');
}
const width = Number.parseInt(widthArg ?? '1440', 10);
const height = Number.parseInt(heightArg ?? '900', 10);
if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200 || width > 7680 || height > 7680) {
  fail(`invalid viewport ${widthArg}x${heightArg}`);
}

try {
  await access(previewPath);
} catch {
  fail(`preview file not found: ${previewPath}`);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    fail('playwright is not installed — run `npm i -D playwright && npx playwright install chromium` in this project.');
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width, height } });
  const anchor = anchorArg && anchorArg.startsWith('#') ? anchorArg : '';
  await page.goto(`${pathToFileURL(previewPath).href}${anchor}`, { waitUntil: 'load', timeout: 30_000 });
  // Give web fonts/CSS animations one settle beat; deterministic budget.
  await page.waitForTimeout(400);
  if (anchor) {
    const target = page.locator(anchor).first();
    if (await target.count() > 0) await target.scrollIntoViewIfNeeded();
  }
  await page.screenshot({ path: outputPath, fullPage: false });
  process.stdout.write(`evolution-screenshot: captured ${outputPath} at ${width}x${height}${anchor ? ` (${anchor})` : ''}\n`);
} catch (error) {
  fail(`render failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser?.close().catch(() => { /* best-effort */ });
}
