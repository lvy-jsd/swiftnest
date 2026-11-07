import { defineConfig } from '@playwright/test';

/**
 * Visual regression config.
 *
 * Baselines are per-platform: ./screenshots/web (this config, Chromium).
 * Desktop (Electron) and Android (device) get their own configs and dirs.
 *
 * Run with:
 *   pnpm exec playwright test --config scripts/visual/playwright.config.ts
 * Update baselines after an intentional design change:
 *   pnpm exec playwright test --config scripts/visual/playwright.config.ts --update-snapshots
 * Diffs (expected/actual/diff PNGs + HTML report) land in ./report.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /visual\.spec\.ts/,
  snapshotPathTemplate: '{testDir}/screenshots/web/{arg}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0.05 },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  timeout: 180_000,
  use: {
    viewport: { width: 1280, height: 800 },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
  },
});