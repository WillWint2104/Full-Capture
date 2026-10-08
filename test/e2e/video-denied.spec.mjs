// Capture when the browser refuses without asking anyone (as on a managed
// computer). Launch flags are per worker, so this needs its own file.
import { test, expect } from '@playwright/test';
import { openHarness } from './helpers.mjs';

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream=deny',
      '--auto-select-desktop-capture-source=Entire screen',
    ],
  },
});

test('an instant refusal of the screen and camera reads as "blocked" with advice', async ({ page }) => {
  await openHarness(page, 'test/e2e/harness/video.entry.js');
  const r = await page.evaluate(async () => {
    const attempt = async fn => {
      try {
        await fn();
        return null;
      } catch (e) {
        return { name: e.name, code: e.code, message: e.message, cause: e.cause?.name };
      }
    };
    return {
      screen: await attempt(() => video.pickScreen({ preset: video.QUALITY_PRESETS.standard })),
      camera: await attempt(() => video.openCamera('')),
    };
  });
  expect(r.screen).toMatchObject({ name: 'CaptureError', code: 'blocked', cause: 'NotAllowedError' });
  expect(r.screen.message).toMatch(/IT settings/);
  expect(r.camera).toMatchObject({ name: 'CaptureError', code: 'blocked', cause: 'NotAllowedError' });
  expect(r.camera.message).toMatch(/address bar/);
});
