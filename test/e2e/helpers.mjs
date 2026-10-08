// Helpers for browser tests. Pages load from file:// like the real app, with
// Chromium's fake camera, microphone and screen (see playwright.config.mjs).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bundleScript } from '../../scripts/bundler.mjs';

// FC_APP points the app tests at another build (e.g. the unstyled skeleton).
export const APP_URL = pathToFileURL(process.env.FC_APP ? path.resolve(ROOT, process.env.FC_APP) : path.join(ROOT, 'full-capture.html')).href;
export const BLANK_URL = pathToFileURL(path.join(ROOT, 'test/e2e/fixtures/blank.html')).href;

/**
 * Open a blank file:// page and inject a bundled harness entry. The entry
 * should assign whatever it wants to test onto `window`.
 *   const page = await openHarness(page, 'test/e2e/harness/recorder.entry.js')
 */
export async function openHarness(page, entry) {
  const { text } = await bundleScript(path.resolve(ROOT, entry));
  await page.goto(BLANK_URL);
  await page.addScriptTag({ content: text });
  return page;
}

/** Collect console errors and uncaught exceptions for later assertions. */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}
