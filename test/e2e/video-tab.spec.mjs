// pickScreen against Chrome's real tab capturer, whose sizes behave like a
// real screen or window (the fake screen simply delivers whatever size is
// asked for). Needs the full Chromium build: the headless shell can't capture
// tabs. The page shares itself, which the app never offers the teacher.
import { test, expect } from '@playwright/test';
import { openHarness, trackErrors } from './helpers.mjs';

test.use({
  channel: 'chromium',
  viewport: { width: 2000, height: 700 },
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture'],
  },
});

let errors;
test.beforeEach(async ({ page }) => {
  errors = trackErrors(page);
  await openHarness(page, 'test/e2e/harness/video.entry.js');
});
test.afterEach(() => {
  expect(errors).toEqual([]);
});

test('a wide tab keeps its full width and size, and keeps up when it grows', async ({ page }) => {
  const picked = await page.evaluate(async () => {
    const md = navigator.mediaDevices;
    const getDisplayMedia = md.getDisplayMedia.bind(md);
    md.getDisplayMedia = options => getDisplayMedia({ ...options, selfBrowserSurface: 'include', preferCurrentTab: true });
    // Keep the tab changing so it sends frames.
    let n = 0;
    setInterval(() => { document.body.textContent = `Lesson ${n++}`; }, 30);
    const s = await video.pickScreen({ preset: video.QUALITY_PRESETS.standard, systemAudio: false });
    window.picked = s;
    window.tap = new kit.FrameTap(s.videoTrack);
    await kit.sleep(300);
    const frame = await tap.next();
    const delivered = [frame.displayWidth, frame.displayHeight];
    frame.close();
    return {
      surface: s.surface, label: s.label, size: [s.width, s.height], native: [s.nativeWidth, s.nativeHeight], delivered,
    };
  });
  expect(picked.surface).toBe('browser');
  expect(picked.label).toBe('One browser tab');
  // The tab (2000 px wide, under 1080 high) fits the standard preset as it is:
  // nothing is squeezed into a 1920×1080 box.
  expect(picked.delivered[0]).toBe(2000);
  expect(picked.delivered[1]).toBeLessThanOrEqual(1080);
  expect(picked.size).toEqual(picked.delivered);
  expect(picked.native).toEqual(picked.delivered);

  await page.setViewportSize({ width: 2400, height: 1000 });
  const grown = await page.evaluate(async () => {
    await kit.sleep(600);
    const frame = await tap.next();
    const delivered = [frame.displayWidth, frame.displayHeight];
    frame.close();
    tap.stop();
    picked.stream.getTracks().forEach(t => t.stop());
    return delivered;
  });
  expect(grown[0]).toBe(2400);
  expect(grown[1]).toBeGreaterThan(picked.delivered[1]);
  expect(grown[1]).toBeLessThanOrEqual(1080);
});
