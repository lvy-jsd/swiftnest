/** Real Apply → DSH process replacement → cookie reconnect; no registry or model network traffic. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { expect, it } from 'vitest';
import { ApiError, type ApiWebSocket } from '@swiftnest/api';
import { AppChannel } from '../../packages/api/src/channel';
import { loadConfig } from '../../server/src/config';
import { startKernel, type RunningKernel } from '../../server/src/kernel';
import { pairingUrl, webAppUrl } from '../../server/src/pairing';
import { PLUGIN_MANIFEST } from '../../server/src/plugins';
import { ConnectionStore } from '../src/connection';
import { launchChromium } from './browser';
import { testTls } from './fixtures/tls';

const { WebSocket } = createRequire(new URL('../../server/package.json', import.meta.url))('ws') as {
  WebSocket: new (
    url: string,
    options: { headers: Readonly<Record<string, string>>; rejectUnauthorized?: boolean },
  ) => ApiWebSocket;
};

// The local test certificate is trusted explicitly by the kernel and Playwright.
const testSocket = (url: string, { headers }: { headers: Readonly<Record<string, string>> }) =>
  new WebSocket(url, { headers, rejectUnauthorized: false });

async function respond(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/v1/models') {
    res.end('{"data":[{"id":"fake"}]}');
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += String(chunk);
  if (!JSON.parse(body).stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Restart chat' } }] }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: 'Reply after real restart.' }, null],
    [{}, 'stop'],
  ]) {
    const chunk = { id: 'fake', model: 'fake', choices: [{ index: 0, delta, finish_reason }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function startApplyKernel(home: string, modelUrl: string, logs: string[], ready: () => void) {
  // DSH's bundled market needs no installation. Disable other optional plugins in
  // the base config (not env locks) so Apply cannot invoke npm or git installers.
  const host = Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === 'IPv4' && !address.internal)!.address;
  const config = loadConfig(undefined, {
    SWIFTNEST_HOME: home,
    SWIFTNEST_LANG: 'en',
    SWIFTNEST_HOST: host,
    SWIFTNEST_PORT: '0',
    SWIFTNEST_DEVICES_PORT: '0',
    SWIFTNEST_DEVICES_MDNS: 'false',
    SWIFTNEST_APP_DIST: fileURLToPath(new URL('../dist/', import.meta.url)),
    SWIFTNEST_MODEL_ID: 'fake',
    SWIFTNEST_MODEL_BASE_URL: modelUrl,
  });
  config.plugins = Object.fromEntries(PLUGIN_MANIFEST.plugins.map(({ id }) => [id, id === 'market']));
  return startKernel(config, {
    env: await testTls(config, host),
    readyTimeoutMs: 20_000,
    onReady(kernel) {
      // Keep the allocated origin and its session cookie when Apply restarts DSH.
      config.port = Number(new URL(kernel.url).port);
      ready();
    },
    onLine: (line) => logs.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
  });
}

async function createChat(page: Page) {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('textbox', { name: 'Write a message' }).waitFor();
  const route = page.url().split('#')[1]!;
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  const links = page.getByRole('main').locator('a[href^="#/chats/"]');
  await links.first().waitFor();
  expect(await links.count()).toBe(1);
  return route;
}

async function chatAfterRestart(page: Page, route: string) {
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  const links = page.getByRole('main').locator('a[href^="#/chats/"]');
  await links.first().waitFor();
  expect(await links.count()).toBe(1);
  expect(await links.first().getAttribute('href')).toBe(`#${route}`);
  await links.first().click();
  await page.getByRole('textbox', { name: 'Write a message' }).fill('hi after restart');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const messages = page.getByRole('list', { name: 'Messages' });
  await messages.getByText('Reply after real restart.', { exact: true }).waitFor();
  await expect.poll(() => messages.locator('[data-streaming="true"]').count()).toBe(0);
  expect(await messages.getByText('hi after restart', { exact: true }).count()).toBe(1);
  expect(await messages.getByText('Reply after real restart.', { exact: true }).count()).toBe(1);
  await page.getByRole('button', { name: 'Go back', exact: true }).click();
  await expect.poll(() => page.getByRole('main').locator('a[href^="#/chats/"]').count()).toBe(1);
}

function observeBrowser(page: Page) {
  const errors: string[] = [];
  const exchanges: string[] = [];
  let sockets = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', () => ++sockets);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.searchParams.has('token')) exchanges.push(url.pathname);
  });
  return { errors, exchanges, sockets: () => sockets };
}

async function applyAndReconnect(page: Page, kernel: RunningKernel, native: ConnectionStore, readyCount: () => number) {
  const originalChild = kernel.child;
  const originalToken = kernel.token;
  const originalUrl = kernel.url;
  await page.getByRole('main').getByRole('link', { name: 'Recommended plugins', exact: true }).click();
  const initial = await native.client!.listPlugins();
  const market = initial.plugins.find((plugin) => plugin.id === 'market')!;
  expect(market).toMatchObject({ active: true, enabled: true, locked: false });
  const toggle = page.getByRole('switch', { name: market.title, exact: true });
  await toggle.click();
  await expect.poll(() => toggle.isChecked()).toBe(false);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(readyCount, { timeout: 25_000 }).toBe(2);
  expect(kernel.child.pid).not.toBe(originalChild.pid);
  expect(originalChild.exitCode !== null || originalChild.signalCode !== null).toBe(true);
  expect(kernel.token).not.toBe(originalToken);
  expect(kernel.url).toBe(originalUrl);
  await expect.poll(() => toggle.isEnabled(), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => native.getSnapshot().status, { timeout: 15_000 }).toBe('connected');
  expect(await native.client!.listPlugins()).toMatchObject({
    pending: false,
    apply: { state: 'idle' },
    plugins: expect.arrayContaining([expect.objectContaining({ id: 'market', active: false, enabled: false })]),
  });
  expect(page.url()).toContain('#/plugins');
  await expect.poll(() => native.getSnapshot().status, { timeout: 15_000 }).toBe('connected');
  expect(native.getSnapshot()).toMatchObject({ pluginRestart: undefined, error: undefined });
  expect(native.client).toBeDefined();
}

async function resumeWith(kernel: RunningKernel, credential: string) {
  const cookie = `swiftnest_native=${credential}`;
  let channel: AppChannel | undefined;
  try {
    channel = await AppChannel.open(
      new URL(kernel.url),
      kernel.channelPairing,
      { createWebSocket: testSocket },
      { t: 'auth', cookie },
      AbortSignal.timeout(2000),
    );
    const response = await channel.fetch(new URL('swiftnest/native/resume', kernel.url), { method: 'POST' }, cookie);
    await response.arrayBuffer();
    return { status: response.status };
  } catch (error) {
    if (error instanceof ApiError && error.httpStatus) return { status: error.httpStatus };
    throw error;
  } finally {
    channel?.close();
  }
}
async function nativeChatAfterRestart(native: ConnectionStore, sessionId: string) {
  const stream = await native.client!.follow(sessionId);
  await native.client!.sendMessage(sessionId, 'native after restart');
  const events = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === 'assistant-end') break;
  }
  stream.close();
  expect(events.filter((e) => e.type === 'user-message' && e.text === 'native after restart')).toHaveLength(1);
  const replies = events.filter((e) => e.type === 'assistant-message' && e.text === 'Reply after real restart.');
  expect(replies).toHaveLength(2);
  expect(new Set(replies.map((e) => e.type === 'assistant-message' && e.messageId)).size).toBe(2);
  expect(await native.client!.listSessions()).toHaveLength(1);
}
async function rotateAndRestart(kernel: RunningKernel, native: ConnectionStore, credentials: string[]) {
  // Rotation saves before reconnecting, and the old credential cannot restore even while the new one is live.
  const beforeRotation = native.client;
  await beforeRotation!.rotateNativePairing();
  await expect.poll(() => native.client, { timeout: 15_000 }).not.toBe(beforeRotation);
  await expect.poll(() => native.getSnapshot().status, { timeout: 15_000 }).toBe('connected');
  expect(credentials).toHaveLength(2);
  expect((await resumeWith(kernel, credentials[0]!)).status).toBe(401);
  // An unannounced restart uses the same backoff and credential, too.
  const nativeClient = native.client;
  await kernel.restart();
  await expect.poll(() => native.client, { timeout: 15_000 }).not.toBe(nativeClient);
  await expect.poll(() => native.getSnapshot().status, { timeout: 15_000 }).toBe('connected');
}
async function revokeNative(page: Page, kernel: RunningKernel, native: ConnectionStore, credentials: string[]) {
  const app = (await native.client!.listDevices()).find((d) => d.device.startsWith('app-'))!;
  expect(app).toMatchObject({ paired: true, capabilities: [] });
  await page.getByRole('link', { name: 'Devices', exact: true }).first().click();
  await page.getByRole('button', { name: 'Revoke device', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke device' });
  await dialog.waitFor();
  const [session] = await native.client!.listSessions();
  const stream = await native.client!.follow(session!.sessionId);
  let streamClosedAt = 0;
  const closed = (async () => {
    for await (const _ of stream) {
      /* Drain history while keeping the stream open. */
    }
    streamClosedAt = performance.now();
  })();
  const revokeStartedAt = performance.now();
  try {
    await dialog.getByRole('button', { name: 'Revoke device', exact: true }).click();
    await expect.poll(() => streamClosedAt, { timeout: 2000, interval: 25 }).toBeGreaterThan(0);
    expect(streamClosedAt - revokeStartedAt).toBeLessThanOrEqual(2000);
  } finally {
    stream.close();
    await closed;
  }
  await expect.poll(() => native.getSnapshot().pluginRestart, { timeout: 2000 }).toBe('pair-required');
  expect(native.getSnapshot().sessions).toHaveLength(1);
  expect(native.client).toBeUndefined();
  expect((await resumeWith(kernel, credentials[1]!)).status).toBe(401);
  await kernel.restart();
  expect((await resumeWith(kernel, credentials[0]!)).status).toBe(401);
  expect((await resumeWith(kernel, credentials[1]!)).status).toBe(401);
}

async function exerciseApply(
  page: Page,
  kernel: RunningKernel,
  native: ConnectionStore,
  readyCount: () => number,
  credentials: string[],
) {
  expect(await native.pair(pairingUrl(kernel.url, kernel.token, kernel.channelPairing))).toBe(true);
  const observed = observeBrowser(page);
  await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
  await page.goto(webAppUrl(kernel.url, kernel.token, kernel.channelPairing));
  await page.waitForURL((url) => url.hash === '#/');
  await page.getByRole('main').getByRole('link', { name: 'Memory', exact: true }).waitFor();
  const route = await createChat(page);
  await applyAndReconnect(page, kernel, native, readyCount);
  expect(observed.sockets()).toBeGreaterThan(1);
  expect(observed.exchanges).toEqual([]);
  await chatAfterRestart(page, route);
  // Both carriers see the same single chat; the native App used no fresh launch token.
  expect(await native.client!.listSessions()).toMatchObject([{ sessionId: route.split('/').at(-1) }]);
  await nativeChatAfterRestart(native, route.split('/').at(-1)!);
  await rotateAndRestart(kernel, native, credentials);
  // Ordinary browser loss still asks to pair; the native App resumed without a token.
  await page.goto(webAppUrl(kernel.url, kernel.token, kernel.channelPairing));
  await page.waitForURL((url) => url.hash === '#/');
  await revokeNative(page, kernel, native, credentials);
  expect(observed.errors).toEqual([]);
}

it.skipIf(process.env.SWIFTNEST_E2E !== '1' || process.env.SWIFTNEST_WEB_E2E !== '1')(
  'real Apply replaces DSH, browser and native owners reconnect automatically, chat survives, and revoke requires pairing',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'swiftnest-apply-real-'));
    const browser = await launchChromium();
    const model = createServer((req, res) => void respond(req, res));
    const logs: string[] = [];
    const credentials: string[] = [];
    let saved: string | undefined;
    const native = new ConnectionStore(async () => ({
      nativePairingStore: {
        load: async () => saved,
        save: async (_root, credential) => {
          saved = credential;
          if (credential) credentials.push(credential);
        },
      },
      cookieMode: 'manual',
      timeoutMs: 2000,
      createWebSocket: testSocket,
    }));
    let kernel: RunningKernel | undefined;
    let page: Page | undefined;
    let readyCount = 0;
    try {
      await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
      kernel = await startApplyKernel(
        home,
        `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
        logs,
        () => ++readyCount,
      );
      page = await browser.newPage({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true });
      page.setDefaultTimeout(15_000);
      await exerciseApply(page, kernel, native, () => readyCount, credentials);
      expect(credentials.some((credential) => logs.join('\n').includes(credential))).toBe(false);
    } catch (error) {
      const body = await page
        ?.locator('body')
        .innerText()
        .catch(() => 'No page');
      throw new Error(`${String(error)}\n${body}\n${logs.slice(-40).join('\n')}`, { cause: error });
    } finally {
      native.disconnect();
      await browser.close();
      await kernel?.stop();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
