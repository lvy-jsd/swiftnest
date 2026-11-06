import { mkdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { webAppUrl } from '../../server/src/pairing';
import { translate } from '../src/i18n';
import { launchChromium } from './browser';
import { MemoryHarness } from './fixtures/memoryHarness';

const code = `const message = "${'手机'.repeat(70)}";\nconsole.log(message);`;
const markdown = [
  '# 结果',
  '',
  '**重点**与 `inline`',
  '',
  '- 第一项',
  '- 第二项',
  '',
  '> 引用',
  '',
  '```js',
  code,
  '```',
  '',
  '| 名称 | 数量 |',
  '| --- | --- |',
  '| 手机 | 2 |',
  '',
  '[网站](https://example.com/) ![图示](https://tracker.invalid/image.png)',
  '',
  '<script>window.markdownExecuted = true</script>',
].join('\n');

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'real assistant Markdown survives replay, copies code, blocks image fetches and fits phone/desktop themes',
  async () => {
    const harness = new MemoryHarness();
    const browser = await launchChromium();
    try {
      harness.replyText = markdown;
      await harness.start();
      const { sessionId } = await harness.client.createSession();
      await harness.turn(sessionId, 'warm-up');
      for (const locale of ['zh-CN', 'en'] as const) {
        await harness.client.setLanguage(locale);
        for (const colorScheme of ['light', 'dark'] as const) {
          for (const width of [390, 1440]) {
            const context = await browser.newContext({
              viewport: { width, height: width === 390 ? 844 : 900 },
              colorScheme,
            });
            await context.grantPermissions(['clipboard-read', 'clipboard-write']);
            const page = await context.newPage();
            const images: string[] = [];
            page.on('request', (request) => {
              if (request.url().includes('tracker.invalid')) images.push(request.url());
            });
            await page.addInitScript((lang) => localStorage.setItem('swiftnest.locale', lang), locale);
            await page.goto(webAppUrl(harness.kernel!.url, harness.kernel!.token));
            await page.getByRole('button', { name: translate(locale, 'newChat'), exact: true }).waitFor();
            await page.evaluate((id) => {
              location.hash = `/chats/${id}`;
            }, sessionId);
            const message = page.locator('.chat-markdown');
            await message.getByRole('heading', { name: '结果' }).waitFor();
            expect(await message.locator('pre code').innerText()).toBe(`${code}\n`);
            expect(await message.locator('table td').first().innerText()).toBe('手机');
            expect(await message.locator('img, script').count()).toBe(0);
            expect(images).toEqual([]);
            const copy = message.locator('.markdown-code__header button');
            expect(await copy.innerText()).toBe(translate(locale, 'chat.copyCode'));
            await copy.click();
            await message.getByRole('button', { name: translate(locale, 'chat.codeCopied'), exact: true }).waitFor();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${code}\n`);
            const target = await copy.boundingBox();
            expect(target!.width).toBeGreaterThanOrEqual(44);
            expect(target!.height).toBeGreaterThanOrEqual(44);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            if (process.env.SWIFTNEST_MARKDOWN_SHOTS) {
              await mkdir(process.env.SWIFTNEST_MARKDOWN_SHOTS, { recursive: true });
              await page.screenshot({
                path: `${process.env.SWIFTNEST_MARKDOWN_SHOTS}/${locale}-${colorScheme}-${width}.png`,
                fullPage: true,
              });
            }
            await page.evaluate(() =>
              Object.defineProperty(navigator.clipboard, 'writeText', {
                value: () => Promise.reject(new Error('denied')),
              }),
            );
            await copy.click();
            await message
              .getByRole('status')
              .filter({ hasText: translate(locale, 'chat.copyFailed') })
              .waitFor();
            await context.close();
          }
        }
      }
    } finally {
      await browser.close();
      await harness.close();
    }
  },
  180000,
);
