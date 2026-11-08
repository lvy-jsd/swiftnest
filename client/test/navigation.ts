import type { Page } from '@playwright/test';
import { translate, type Locale } from '../src/i18n';

/** Exercise the visible navigation at either breakpoint. */
export async function openNavigation(page: Page, locale: Locale = 'en') {
  const menu = page.getByRole('button', { name: translate(locale, 'shell.openNavigation'), exact: true });
  if ((page.viewportSize()?.width ?? 1440) < 600) {
    await menu.waitFor();
    const drawer = page.getByRole('dialog', { name: translate(locale, 'shell.navigation'), exact: true });
    if (!(await drawer.isVisible())) await menu.click();
    return drawer;
  }
  await page.locator('.sidebar').waitFor();
  return page.locator('.sidebar');
}

export async function openPreferences(page: Page, locale: Locale = 'en') {
  await page
    .getByRole('button', { name: translate(locale, 'openPreferences'), exact: true })
    .filter({ visible: true })
    .first()
    .click();
  return page.getByRole('dialog', { name: translate(locale, 'preferences'), exact: true });
}

export async function openSettingsPage(
  page: Page,
  key: 'devices' | 'shell.models' | 'shell.plugins',
  locale: Locale = 'en',
) {
  // Pairing replaces the phone header; use the settled shell's settings entry.
  await page.waitForURL((url) => !url.hash.startsWith('#/pair'));
  const preferences = await openPreferences(page, locale);
  await preferences.getByRole('button', { name: translate(locale, key), exact: true }).click();
  const route = key === 'devices' ? key : key.slice('shell.'.length);
  await page.waitForURL((url) => url.hash === `#/${route}`);
  return preferences;
}
