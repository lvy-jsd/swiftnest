import { expect, it } from 'vitest';
import { ChatSearchHarness, OLD_CHAT_TEXT } from './fixtures/chatSearchHarness';
import { launchChromium } from './browser';
import { webAppUrl } from '../../server/src/pairing';
import { translate } from '../src/i18n';

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'real phone-width App searches body text, highlights safely, opens the chat and guides cloud consent',
  async () => {
    const harness = new ChatSearchHarness();
    const browser = await launchChromium();
    try {
      await harness.start();
      const old = await harness.client.createSession();
      await harness.turn(old.sessionId, OLD_CHAT_TEXT);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
      const en = (key: Parameters<typeof translate>[1]) => translate('en', key);
      const search = page.getByRole('searchbox', { name: en('search') });
      await search.fill('杭州');
      const results = page.getByRole('list', { name: en('chatSearchResults') });
      await results.getByRole('link').first().waitFor();
      expect(await results.locator('mark').first().textContent()).toBe('杭州');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await results.getByRole('link').first().click();
      await expect.poll(() => page.url()).toContain(`#/chats/${old.sessionId}`);
      await page.getByText(OLD_CHAT_TEXT, { exact: true }).waitFor();
      await page.getByRole('button', { name: en('chatActions') }).click();
      await page.getByText(en('chatSearchAdvanced'), { exact: true }).click();
      await page.getByRole('switch', { name: en('chatSearchSemantic'), exact: true }).waitFor();
      await page.getByLabel(en('chatSearchSource')).selectOption('cloud');
      expect(await page.getByRole('switch', { name: en('chatSearchCloudConsent') }).isChecked()).toBe(false);
      expect(await page.getByRole('link', { name: en('chatSearchKeyHelp') }).getAttribute('href')).toBe('#/models');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    } catch (error) {
      throw new Error(`${String(error)}\n${harness.logs.slice(-60).join('\n')}`, { cause: error });
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  120_000,
);
