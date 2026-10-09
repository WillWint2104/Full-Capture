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

/**
 * Page init script: Document Picture-in-Picture as an iframe, so the floating
 * controls can be driven headlessly. `window.__pip` is the open window. Like a
 * real one it closes: close() fires `pagehide` in it and removes it. Its
 * screen is this page's (headless: one display) unless `window.__pipScreen =
 * {isExtended, width, height}` and `window.__pipDpr` say otherwise (read live).
 * `window.__pipCloseDelay` (ms) makes it slow to close; `Infinity` never closes.
 * `window.__pipEvents` lists ['opened'|'closed', performance.now()].
 */
export const fakePip = () => {
  window.__pipEvents = [];
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: {
    window: null,
    async requestWindow() {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:420px;border:0';
      document.body.append(f);
      await new Promise(r => setTimeout(r, 50));
      const w = f.contentWindow;
      const realScreen = window.screen;
      Object.defineProperty(w, 'screen', { configurable: true, get: () => window.__pipScreen || realScreen });
      Object.defineProperty(w, 'devicePixelRatio', { configurable: true, get: () => window.__pipDpr || window.devicePixelRatio });
      const gone = () => {
        if (!f.isConnected) return;
        w.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
        f.remove();
        if (window.__pip === w) window.__pip = null;
        if (this.window === w) this.window = null;
        window.__pipEvents.push(['closed', performance.now()]);
      };
      w.close = () => {
        const delay = window.__pipCloseDelay || 0;
        if (delay === Infinity) return;
        if (delay) setTimeout(gone, delay); else gone();
      };
      window.__pip = w;
      this.window = w;
      window.__pipEvents.push(['opened', performance.now()]);
      return w;
    },
  } });
};

/**
 * Page init script: report `window.__freeBytes` (default 50 GB) of free storage. Test
 * browsers get under 1 GB, which raises the "Storage is nearly full" warning.
 */
export const freeStorage = () => {
  const real = navigator.storage.estimate.bind(navigator.storage);
  navigator.storage.estimate = async () => {
    const est = await real();
    return { ...est, quota: (est.usage || 0) + (window.__freeBytes ?? 50e9) };
  };
};

/** Collect console errors and uncaught exceptions for later assertions. */
export function trackErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}
