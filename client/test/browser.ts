/** One Chromium launch for every browser e2e test. Set SWIFTNEST_CHROMIUM to use a browser outside Playwright's cache. */
import { chromium, type Browser } from '@playwright/test';

/** Opting in with SWIFTNEST_WEB_E2E=1 means the browser must start: a missing one fails the test instead of skipping it. */
export function launchChromium(): Promise<Browser> {
  const executablePath = process.env.SWIFTNEST_CHROMIUM;
  return chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--no-proxy-server'],
  });
}
