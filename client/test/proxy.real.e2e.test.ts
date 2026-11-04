import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadConfig } from '../../server/src/config';
import { startKernel, type RunningKernel } from '../../server/src/kernel';
import { webAppUrl } from '../../server/src/pairing';
import { reverseProxy } from './fixtures/reverseProxy';
import { launchChromium } from './browser';

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'real TLS proxy: first pairing, encrypted API, Secure HttpOnly cookie, reload and no credential in Web storage',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-proxy-'));
    const host = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry?.family === 'IPv4' && !entry.internal)!.address;
    const proxy = await reverseProxy(home, host);
    const browser = await launchChromium();
    let kernel: RunningKernel | undefined;
    try {
      const config = loadConfig(undefined, {
        SWIFTNEST_HOME: home,
        SWIFTNEST_LANG: 'en',
        SWIFTNEST_PORT: '0',
        SWIFTNEST_DEVICES_PORT: '0',
        SWIFTNEST_DEVICES_MDNS: 'false',
        SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
      });
      kernel = await startKernel(config, {
        env: {
          SWIFTNEST_TRUSTED_PROXY_IP: '127.0.0.1',
          SWIFTNEST_TRUSTED_PROXY_ORIGIN: new URL(proxy.url).origin,
        },
      });
      proxy.forwardTo(kernel.url);
      expect(kernel.channelPairing.addresses.lan[0]).toBe(proxy.url);
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
      const sockets: string[] = [];
      page.on('websocket', (wire) => sockets.push(wire.url()));
      await page.goto(webAppUrl(proxy.url, kernel.token, kernel.channelPairing));
      await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
      expect(sockets).toContain(new URL('swiftnest/channel', proxy.url).href.replace('https:', 'wss:'));
      const cookies = await page.context().cookies();
      const session = cookies.find((cookie) => cookie.httpOnly)!;
      expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
      expect(await page.evaluate(() => document.cookie)).not.toContain(session.value);
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Write a message' }).waitFor();
      const chat = page.url();
      await page.reload();
      await page.getByRole('textbox', { name: 'Write a message' }).waitFor();
      expect(page.url()).toBe(chat);
      await expect.poll(() => page.getByRole('link', { name: 'Pair server', exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(
        session.value,
      );
      expect(sockets.filter((url) => url.endsWith('/swiftnest/channel')).length).toBeGreaterThanOrEqual(2);
    } finally {
      await browser.close();
      await proxy.close();
      await kernel?.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
  90000,
);
