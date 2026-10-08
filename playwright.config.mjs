import { defineConfig } from '@playwright/test';

// The app runs from file:// with Chromium's fake camera, mic and screen, so
// every capture path can be exercised headlessly.
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    launchOptions: {
      // Without a UTF-8 locale, Chromium on Linux renames downloads with
      // non-ASCII names (e.g. "Équations") to "download". Windows is unaffected.
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
    permissions: ['microphone', 'camera'],
  },
});
