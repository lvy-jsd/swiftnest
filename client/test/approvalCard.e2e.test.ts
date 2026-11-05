import { mkdir, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import type { Browser, Page } from '@playwright/test';
import type { ApprovalItem } from '@swiftnest/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/design/palette';
import { translate, type Locale } from '../src/i18n';
import { launchChromium } from './browser';

const now = '2026-11-06T12:00:00.000Z';
const items: ApprovalItem[] = (['read', 'write', 'exec', 'sensitive'] as const).map((risk, index) => ({
  id: risk,
  kind: 'dsh',
  requester: index === 3 ? `Assistant-${'long-identity-'.repeat(12)}` : 'Ivy',
  device: 'My computer',
  risk,
  tool: index === 3 ? `computer__files__${'long_tool_'.repeat(16)}` : 'computer__files__read',
  args: { path: `/shared/${'long-directory/'.repeat(40)}report.txt`, lines: Array.from({ length: 80 }, (_, n) => n) },
  summary: 'Check the shared report before continuing.',
  displayReason: index === 1 ? undefined : { en: 'Read the shared report?', 'zh-CN': '允许读取共享报告吗？' },
  createdAt: now,
  // Fractional minutes round up; a positive sub-minute stays 1; the exact boundary is expired.
  expiresAt: new Date(Date.parse(now) + [360_001, 1, 0, -60_000][index]!).toISOString(),
  state: 'pending',
}));

// Serve a virtual fixture so this visual test needs no new production entry or fixture file.
const fixturePath = resolve('client/test/__approval-card-fixture.tsx');
const fixture = `
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, ConnectionStore } from '/src/connection';
import { ApprovalInboxProvider } from '/src/inboxState';
import { InboxApproval } from '/src/inbox';
import { ThemeProvider } from '/src/design/theme';
import { I18nProvider } from '/src/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '/src/styles.css';
const items = ${JSON.stringify(items)};
const inbox = { items, settings: { remind: true, autoAllowLowRisk: false,
  timeouts: { dsh: 600000, device: 600000, transfer: 600000 } } };
const calls = [];
let release;
const store = new ConnectionStore();
let state = { status: 'connected', root: '', sessions: [] };
const listeners = new Set();
store.getSnapshot = () => state;
store.subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
store.client = {
  approvalInbox: async () => inbox,
  watchApprovals: async ({ signal }) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    }, close() {}
  }),
  answerInboxApproval: async (id, allowed) => {
    calls.push({ id, allowed });
    await new Promise(resolve => { release = resolve; });
    return inbox;
  },
};
window.__approvalCard = {
  calls,
  release: () => release(),
  setConnected: (connected) => {
    state = { ...state, status: connected ? 'connected' : 'disconnected' };
    for (const notify of listeners) notify();
  },
};
const locale = new URL(location.href).searchParams.get('locale');
document.documentElement.lang = locale;
createRoot(document.getElementById('root')).render(
  <ThemeProvider><I18nProvider initialLocale={locale}><ConnectionProvider store={store}>
    <ApprovalInboxProvider>
      <main className="page__body card-groups" style={{ padding: 'var(--page-gutter)' }}>
        {items.map(item => <InboxApproval key={item.id} item={item} />)}
      </main>
    </ApprovalInboxProvider>
  </ConnectionProvider></I18nProvider></ThemeProvider>
);
`;

async function checkCards(page: Page, locale: Locale) {
  const cards = page.locator('.approval-card');
  await cards.last().waitFor();
  await page.evaluate(() => document.fonts.ready);
  expect(await cards.count()).toBe(items.length);
  const ratios: Record<string, number> = {};
  for (const [index, card] of (await cards.all()).entries()) {
    const item = items[index]!;
    const styles = await card.evaluate((element) => {
      const style = getComputedStyle(element);
      const chip = getComputedStyle(element.querySelector('.approval-card__risk')!);
      // Canvas resolves rgb(), color(srgb ...) and color-mix() from computed styles to actual sRGB.
      const hex = (color: string) => {
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const rgba = [...ctx.getImageData(0, 0, 1, 1).data];
        if (rgba[3] !== 255) throw new Error(`Expected opaque chip/card color: ${color}`);
        return `#${rgba
          .slice(0, 3)
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')}`;
      };
      return {
        radius: style.borderRadius,
        border: style.borderWidth,
        shadow: style.boxShadow,
        surface: hex(style.backgroundColor),
        expectedSurface: hex(style.getPropertyValue('--color-surface1')),
        borderColor: hex(style.borderColor),
        expectedBorder: hex(style.getPropertyValue('--color-border')),
        foreground: hex(chip.color),
        background: hex(chip.backgroundColor),
      };
    });
    expect(styles.radius).toBe('20px');
    expect(styles.border).toBe('1px');
    expect(styles.shadow).toBe('none');
    expect(styles.surface).toBe(styles.expectedSurface);
    expect(styles.borderColor).toBe(styles.expectedBorder);
    ratios[item.risk] = contrastRatio(styles.foreground, styles.background);
    expect(ratios[item.risk], `${item.risk}: ${styles.foreground} on ${styles.background}`).toBeGreaterThanOrEqual(4.5);
    expect(await card.locator('.approval-card__risk').textContent()).toBe(translate(locale, item.risk));
    expect(await card.locator('.approval-card__metadata').textContent()).toBe(`${item.requester} · ${item.device}`);
    expect(await card.locator('code').textContent()).toBe(item.tool);
    expect(await card.locator('.approval-card__reason').textContent()).toBe(
      item.displayReason?.[locale] ?? item.summary,
    );
    const expectedExpiry =
      locale === 'en'
        ? ['Expires in 7 minutes', 'Expires in 1 minute', 'Expired', 'Expired']
        : ['7分钟后过期', '1分钟后过期', '已过期', '已过期'];
    expect(await card.locator('time').textContent()).toBe(expectedExpiry[index]);
    expect(await card.locator('time').getAttribute('datetime')).toBe(item.expiresAt);
    expect(await card.locator('time').getAttribute('title')).toBe(
      await page.evaluate(({ expiresAt, lang }) => new Date(expiresAt).toLocaleString(lang), {
        expiresAt: item.expiresAt,
        lang: locale,
      }),
    );
    for (const control of await card.locator('button, summary').all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await card.locator('button').count()).toBe(2);
    expect(
      await card.getByRole('button', { name: translate(locale, 'deny'), exact: true }).getAttribute('class'),
    ).toContain('button--soft');
    expect(
      await card.getByRole('button', { name: translate(locale, 'approve'), exact: true }).getAttribute('class'),
    ).toContain('button--primary');
    const icons = card.locator('svg');
    expect(await icons.count()).toBeGreaterThan(0);
    for (const icon of await icons.all()) {
      expect(await icon.getAttribute('viewBox')).toBe('0 0 24 24');
      expect(await icon.getAttribute('stroke-width')).toBe('1.7');
      expect(await icon.getAttribute('aria-hidden')).toBe('true');
    }
    // Check visible copy and generated adornments, including the disclosure indicator.
    const text = await card.evaluate((element) =>
      [
        element.textContent,
        ...[element, ...element.querySelectorAll('*')].flatMap((child) =>
          ['::before', '::after', '::marker'].map((pseudo) => getComputedStyle(child, pseudo).content),
        ),
      ].join(''),
    );
    expect(text).not.toMatch(/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u);
    expect(await card.locator('details').getAttribute('open')).toBeNull();
    await card.locator('summary').click();
    const pre = card.locator('pre');
    expect(await pre.isVisible()).toBe(true);
    expect(await pre.textContent()).toBe(JSON.stringify(item.args, null, 2));
    const detailStyle = await pre.evaluate((element) => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, maxHeight: style.maxHeight, overflow: style.overflow };
    });
    expect(detailStyle.radius).toBe('12px');
    expect(Number.parseFloat(detailStyle.maxHeight)).toBeCloseTo(page.viewportSize()!.height * 0.4, 1);
    expect(detailStyle.overflow).toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.locator('summary').click();
    expect(await pre.isVisible()).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  console.info(
    `${locale} ${await page.locator('html').getAttribute('data-theme')} ${page.viewportSize()!.width}:`,
    ratios,
  );
}

async function checkAnswers(page: Page, locale: Locale) {
  const card = page.locator('.approval-card').first();
  for (const [index, allowed] of [false, true].entries()) {
    await card.getByRole('button', { name: translate(locale, allowed ? 'approve' : 'deny'), exact: true }).click();
    await expect.poll(() => page.locator('.approval-card button:disabled').count()).toBe(8);
    expect(await page.evaluate(() => (window as any).__approvalCard.calls)).toEqual(
      [false, true].slice(0, index + 1).map((answer) => ({ id: 'read', allowed: answer })),
    );
    await page.evaluate(() => (window as any).__approvalCard.release());
    await expect.poll(() => page.locator('.approval-card button:disabled').count()).toBe(0);
  }
  await page.evaluate(() => (window as any).__approvalCard.setConnected(false));
  await expect.poll(() => page.locator('.approval-card button:disabled').count()).toBe(8);
  await page.evaluate(() => (window as any).__approvalCard.setConnected(true));
  await expect.poll(() => page.locator('.approval-card button:disabled').count()).toBe(0);
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.SWIFTNEST_UI_SCREENSHOT_DIR;
  if (!directory) return;
  const assertOutsideRepo = (path: string) => {
    const fromRepo = relative(resolve('.'), path);
    if (!fromRepo || (!isAbsolute(fromRepo) && fromRepo !== '..' && !fromRepo.startsWith('../')))
      throw new Error('Approval screenshots must be outside the repository.');
  };
  assertOutsideRepo(resolve(directory));
  await mkdir(directory, { recursive: true });
  assertOutsideRepo(await realpath(directory));
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true, animations: 'disabled' });
}

describe.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')('approval card visual matrix', () => {
  let server: ViteDevServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await createServer({
      root: resolve('client'),
      configFile: false,
      cacheDir: '/tmp/swiftnest-approval-card-vite',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        react(),
        {
          name: 'approval-card-fixture',
          resolveId(id) {
            if (id === '/__approval-card-fixture.tsx') return fixturePath;
          },
          load(id) {
            if (id === fixturePath) return fixture;
          },
          configureServer(s) {
            s.middlewares.use('/__approval_card', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__approval_card',
                  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__approval-card-fixture.tsx"></script></body></html>',
                ),
              );
            });
          },
        },
      ],
    });
    await server.listen();
    browser = await launchChromium();
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });
  for (const width of [390, 1440]) {
    for (const mode of ['light', 'dark'] as const) {
      for (const locale of ['zh-CN', 'en'] as const) {
        it(`${width}×${width === 390 ? 844 : 900}, ${mode}, ${locale}: tokens, targets, contrast, expiry and answers`, async () => {
          const page = await browser.newPage({
            viewport: { width, height: width === 390 ? 844 : 900 },
            colorScheme: mode,
            reducedMotion: 'reduce',
          });
          const errors: string[] = [];
          const external: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('request', (request) => {
            if (new URL(request.url()).origin !== new URL(server.resolvedUrls!.local[0]!).origin)
              external.push(request.url());
          });
          try {
            await page.clock.setFixedTime(new Date(now));
            await page.goto(`${server.resolvedUrls!.local[0]}__approval_card?locale=${locale}`);
            await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(mode);
            await checkCards(page, locale);
            await screenshot(page, `approval-${locale}-${mode}-${width}`);
            await checkAnswers(page, locale);
            expect(errors).toEqual([]);
            expect(external).toEqual([]);
          } finally {
            await page.close();
          }
        });
      }
    }
  }
});
