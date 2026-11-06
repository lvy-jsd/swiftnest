import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Browser, Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contrastRatio } from '../src/design/palette';
import { translate, type Locale } from '../src/i18n';
import { launchChromium } from './browser';

const sessions = [
  { sessionId: 'recent-2', title: 'Second recent', updatedAt: 400, running: false, blank: true },
  { sessionId: 'old', title: 'Outside recent three', updatedAt: 100, running: false, blank: true },
  { sessionId: 'running', title: 'Running older task', updatedAt: 50, running: true, blank: true },
  { sessionId: 'recent-1', title: 'Most recent task', updatedAt: 500, running: false, blank: true },
  { sessionId: 'recent-3', title: 'Third recent', updatedAt: 300, running: false, blank: true },
];
const fixturePath = resolve('client/test/__context-rail-fixture.tsx');
// Exercise the real App/providers against deterministic in-memory API snapshots.
const fixture = `
import { createRoot } from 'react-dom/client';
import { App } from '/src/App';
import { ConnectionProvider, ConnectionStore } from '/src/connection';
import { ThemeProvider } from '/src/design/theme';
import { I18nProvider } from '/src/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '/src/styles.css';
const locale = new URL(location.href).searchParams.get('locale');
const sessions = ${JSON.stringify(sessions)};
const devices = Array.from({ length: 5 }, (_, i) => ({
  device: 'device-' + i, name: 'Device ' + (i + 1), online: i < 4,
  paired: true, fingerprint: String(i), capabilities: []
}));
let items = [0, 1].map(i => ({ id: String(i), kind: 'dsh', state: 'pending' }));
const counts = { devices: 0, approvals: 0, follow: 0 };
const wakes = new Set();
function stream(signal) {
  return { close() {}, async *[Symbol.asyncIterator]() {
    while (!signal.aborted) {
      await new Promise(resolve => {
        wakes.add(resolve);
        signal.addEventListener('abort', resolve, { once: true });
      });
      if (!signal.aborted) yield { type: 'approvals-changed' };
    }
  }};
}
const store = new ConnectionStore();
let state = { status: 'connected', root: '', sessions };
const listeners = new Set();
store.getSnapshot = () => state;
store.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
store.refresh = async () => {};
store.client = {
  listDevices: async () => devices,
  listDevicePairings: async () => [],
  listTransfers: async () => [],
  approvalInbox: async () => ({ items, settings: { remind: true, autoAllowLowRisk: false, timeouts: { dsh: 600000, device: 600000, transfer: 600000 } } }),
  listPlugins: async () => ({ plugins: [], unaudited: [], pending: false, apply: { state: 'idle' } }),
  getPreferences: async () => ({ lang: locale }),
  watchDevices: async ({ signal }) => { counts.devices++; return stream(signal); },
  watchApprovals: async ({ signal }) => { counts.approvals++; return stream(signal); },
  follow: async (_id, { signal }) => { counts.follow++; return stream(signal); },
  close() {},
};
window.__contextRail = {
  counts,
  setStatus(status) { state = { ...state, status }; for (const notify of listeners) notify(); },
  clearApprovals() { items = []; for (const wake of wakes) wake(); wakes.clear(); },
  clearTitle() {
    state = { ...state, sessions: state.sessions.map(s => ({ ...s, title: undefined })) };
    for (const notify of listeners) notify();
  },
};
createRoot(document.getElementById('root')).render(
  <ThemeProvider><I18nProvider initialLocale={locale}><ConnectionProvider store={store}>
    <App />
  </ConnectionProvider></I18nProvider></ThemeProvider>
);
`;

async function targetsAndOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = page
    .locator('button, a, input, textarea, select, summary, [role="button"]')
    .filter({ visible: true });
  for (const control of await controls.all()) {
    const rect = await control.boundingBox();
    // The skip link is offscreen until focused; its focused size is checked separately.
    if (rect!.y + rect!.height < 0) continue;
    const label = (await control.getAttribute('aria-label')) ?? (await control.textContent());
    expect(rect!.width, label ?? undefined).toBeGreaterThanOrEqual(44);
    expect(rect!.height, label ?? undefined).toBeGreaterThanOrEqual(44);
  }
}

async function contrast(page: Page, selector: string, surface: string) {
  const colors = await page.locator(selector).evaluateAll(
    (elements, surface) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const hex = (color: string) => {
          const ctx = document.createElement('canvas').getContext('2d')!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          return (
            '#' +
            [...ctx.getImageData(0, 0, 1, 1).data]
              .slice(0, 3)
              .map((v) => v.toString(16).padStart(2, '0'))
              .join('')
          );
        };
        return {
          foreground: hex(style.color),
          background: hex(style.getPropertyValue(surface)),
          text: element.textContent,
        };
      }),
    surface,
  );
  expect(colors.length).toBeGreaterThan(0);
  const ratios = colors.map(({ foreground, background, text }) => {
    const ratio = contrastRatio(foreground, background);
    expect(ratio, `${text}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    return ratio;
  });
  return Math.min(...ratios);
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.SWIFTNEST_UI_SCREENSHOT_DIR;
  if (!directory) return;
  const outside = (path: string) => {
    const fromRepo = relative(resolve('.'), path);
    if (!fromRepo || (!isAbsolute(fromRepo) && fromRepo !== '..' && !fromRepo.startsWith('../')))
      throw new Error('Context rail screenshots must be outside the repository.');
  };
  outside(resolve(directory));
  await mkdir(directory, { recursive: true });
  outside(await realpath(directory));
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
}

async function checkRail(page: Page, locale: Locale) {
  const cards = page.locator('.context-rail__card');
  expect(await cards.count()).toBe(3);
  await expect
    .poll(() => cards.nth(0).locator('p').textContent())
    .toBe(translate(locale, 'shell.devicesOnline').replace('{count}', '4'));
  expect(await cards.nth(0).locator('li').allTextContents()).toEqual(['Device 1', 'Device 2', 'Device 3', '+1']);
  expect(await cards.nth(1).locator('a').textContent()).toBe(
    translate(locale, 'inboxPendingCount').replace('{count}', '2'),
  );
  expect(await cards.nth(1).locator('a').getAttribute('href')).toBe('#/approvals');
  expect(await cards.nth(1).locator('a').getAttribute('aria-label')).toBe(
    `${translate(locale, 'rail.waiting')}: ${translate(locale, 'inboxPendingCount').replace('{count}', '2')}`,
  );
  const links = cards.nth(2).locator('a');
  expect(await links.locator(':scope > span:first-child').allTextContents()).toEqual([
    'Running older task',
    'Most recent task',
    'Second recent',
    'Third recent',
  ]);
  expect(await cards.nth(2).locator('.context-rail__running').textContent()).toBe(
    translate(locale, 'shell.runningChats'),
  );
  expect(await links.first().getAttribute('href')).toBe('#/chats/running');
  for (const card of await cards.all()) {
    expect(
      await card.evaluate((element) => {
        const style = getComputedStyle(element);
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--color-surface1)';
        probe.style.border = '1px solid var(--color-border)';
        element.append(probe);
        const expected = getComputedStyle(probe);
        const matches =
          style.backgroundColor === expected.backgroundColor && style.borderColor === expected.borderColor;
        probe.remove();
        return [style.borderRadius, style.borderWidth, style.boxShadow, matches];
      }),
    ).toEqual(['20px', '1px', 'none', true]);
  }
}

describe.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')('context rail layout matrix', () => {
  let server: ViteDevServer;
  let browser: Browser;
  beforeAll(async () => {
    server = await createServer({
      root: resolve('client'),
      configFile: false,
      cacheDir: '/tmp/swiftnest-context-rail-vite',
      server: { host: '127.0.0.1', port: 0 },
      plugins: [
        react(),
        {
          name: 'context-rail-fixture',
          resolveId(id) {
            if (id === '/__context-rail-fixture.tsx') return fixturePath;
          },
          load(id) {
            if (id === fixturePath) return fixture;
          },
          configureServer(s) {
            s.middlewares.use('/__context_rail', async (_req, res) => {
              res.setHeader('content-type', 'text/html');
              res.end(
                await s.transformIndexHtml(
                  '/__context_rail',
                  '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__context-rail-fixture.tsx"></script></body></html>',
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
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]) {
    for (const mode of ['light', 'dark'] as const) {
      for (const locale of ['zh-CN', 'en'] as const) {
        it(`${width}×${height}, ${mode}, ${locale}: real snapshots, identity, targets, contrast`, async () => {
          const page = await browser.newPage({
            viewport: { width: width!, height: height! },
            colorScheme: mode,
            reducedMotion: 'reduce',
          });
          const errors: string[] = [];
          page.on('pageerror', (error) => errors.push(error.message));
          try {
            await page.clock.setFixedTime(new Date('2026-11-06T12:00:00Z'));
            await page.goto(`${server.resolvedUrls!.local[0]}__context_rail?locale=${locale}`);
            await page.locator('.suggestion').last().waitFor();
            await page.evaluate(() => document.fonts.ready);
            await expect.poll(() => page.locator('html').getAttribute('data-theme')).toBe(mode);
            await checkRail(page, locale);
            expect(await page.locator('.context-rail').isVisible()).toBe(width === 1440);
            expect(await page.locator('.sidebar').isVisible()).toBe(width !== 390);
            expect(await page.locator('.main-content').isVisible()).toBe(true);
            if (width === 1440) {
              expect((await page.locator('.sidebar').boundingBox())!.width).toBeCloseTo(242, 0);
              expect((await page.locator('.context-rail').boundingBox())!.width).toBeCloseTo(226, 0);
            }
            expect((await page.locator('.home-center').boundingBox())!.width).toBeLessThanOrEqual(720);
            expect(await page.locator('.suggestion__subtitle').allTextContents()).toEqual(
              ['home.plan.subtitle', 'home.explain.subtitle', 'home.write.subtitle', 'home.ideas.subtitle'].map((key) =>
                translate(locale, key as Parameters<typeof translate>[1]),
              ),
            );
            if (width === 390) {
              expect(await page.locator('.phone-header').isVisible()).toBe(true);
              const title = await page.locator('.phone-header__title').boundingBox();
              expect(title!.x + title!.width / 2).toBeCloseTo(195, 0);
              expect(await page.locator('.phone-header__title').textContent()).toBe(
                await page.locator('.home-greeting h1').textContent(),
              );
              for (const button of await page.locator('.phone-header .icon-button').all()) {
                expect(
                  await button.evaluate((element) => {
                    const style = getComputedStyle(element, '::before');
                    return [style.width, style.height, style.boxShadow];
                  }),
                ).toEqual(['32px', '32px', 'none']);
              }
            }
            await targetsAndOverflow(page);
            await page.locator('.skip-link').focus();
            await targetsAndOverflow(page);
            await page.locator('[data-composer]').fill('Persistent home draft');
            const bodyContrast = await contrast(
              page,
              '.context-rail__card p, .context-rail__card li, .context-rail__card a, .context-rail__running',
              '--color-surface1',
            );
            await screenshot(page, `context-${locale}-${mode}-${width}-home`);
            await page.evaluate(() => {
              location.hash = '/chats/running';
            });
            await page.locator('.chat-title__name').waitFor();
            expect(await page.locator('.chat-title__name').textContent()).toBe('Running older task');
            if (width === 390) {
              const title = await page.locator('.chat-title').boundingBox();
              expect(title!.x + title!.width / 2).toBeCloseTo(195, 0);
              const dot = page.locator('.chat-connection-dot');
              expect(await dot.isVisible()).toBe(true);
              expect(await dot.getAttribute('aria-label')).toBe(translate(locale, 'connected'));
              for (const button of await page.locator('.page-header .icon-button').all()) {
                expect(
                  await button.evaluate((element) => [
                    getComputedStyle(element).boxShadow,
                    getComputedStyle(element, '::before').width,
                    getComputedStyle(element, '::before').height,
                  ]),
                ).toEqual(['none', '32px', '32px']);
              }
            }
            await targetsAndOverflow(page);
            const labelContrast = await contrast(page, '.chat-title__status', '--color-background');
            console.info(
              `${width} ${mode} ${locale}: body contrast ${bodyContrast.toFixed(2)}, status label ${labelContrast.toFixed(2)}`,
            );
            await screenshot(page, `context-${locale}-${mode}-${width}-chat`);
            if (process.env.SWIFTNEST_UI_SCREENSHOT_DIR) {
              await writeFile(
                resolve(process.env.SWIFTNEST_UI_SCREENSHOT_DIR, `context-${locale}-${mode}-${width}-metrics.json`),
                JSON.stringify({ width, height, mode, locale, bodyContrast, labelContrast }, null, 2),
              );
            }
            expect(await page.evaluate(() => (window as any).__contextRail.counts)).toEqual({
              devices: 2,
              approvals: 1,
              follow: 1,
            });
            await page.evaluate(() => (window as any).__contextRail.clearApprovals());
            await expect
              .poll(() => page.locator('.context-rail__card').nth(1).locator('a').textContent())
              .toBe(translate(locale, 'rail.nothingWaiting'));
            await page.evaluate(() => (window as any).__contextRail.clearTitle());
            await expect
              .poll(() => page.locator('.chat-title__name').textContent())
              .toBe(translate(locale, 'untitledChat'));
            if (width === 390) {
              for (const status of ['connecting', 'disconnected']) {
                await page.evaluate((status) => (window as any).__contextRail.setStatus(status), status);
                const dot = page.locator('.chat-connection-dot');
                await expect
                  .poll(() => dot.getAttribute('aria-label'))
                  .toBe(translate(locale, status as 'connecting' | 'disconnected'));
                expect(await dot.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
                  await dot.evaluate(
                    (element, token) => {
                      const probe = document.createElement('span');
                      probe.style.color = `var(${token})`;
                      element.append(probe);
                      const color = getComputedStyle(probe).color;
                      probe.remove();
                      return color;
                    },
                    status === 'connecting' ? '--color-waiting' : '--color-danger',
                  ),
                );
              }
              expect(await page.locator('.context-rail__card').nth(1).locator('a').textContent()).toContain(
                translate(locale, 'rail.unavailable'),
              );
              await page.evaluate(() => (window as any).__contextRail.setStatus('connected'));
            }
            await page.evaluate(() => {
              location.hash = '/';
            });
            await page.locator('.suggestion').first().waitFor();
            expect(await page.locator('[data-composer]').inputValue()).toBe('Persistent home draft');
            await page.evaluate(() => {
              location.hash = '/pair';
            });
            await page.locator('.page--form').waitFor();
            expect(await page.locator('.page-header h1').textContent()).toBe(translate(locale, 'pair'));
            if (width === 390) {
              const title = await page.locator('.page-header__titles').boundingBox();
              expect(title!.x + title!.width / 2).toBeCloseTo(195, 0);
              expect(await page.locator('.main-content > .phone-header').count()).toBe(0);
            }
            await targetsAndOverflow(page);
            expect(errors).toEqual([]);
          } finally {
            await page.close();
          }
        }, 60_000);
      }
    }
  }
});
