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
