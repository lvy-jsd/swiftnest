import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import { expect, it } from 'vitest';
import type { Page } from '@playwright/test';
import { MemoryHarness } from './fixtures/memoryHarness';
import { launchChromium } from './browser';
import { png } from './fixtures/png';
import { webAppUrl } from '../../server/src/pairing';

async function open(page: Page, id: string, marker: string) {
  await page.evaluate((id) => {
    location.hash = `/chats/${id}`;
  }, id);
  await expect.poll(() => page.locator('.transcript').innerText(), { timeout: 25_000 }).toContain(marker);
}

it.skipIf(process.env.SWIFTNEST_CACHE_METRICS !== '1')(
  'browser evidence: twenty warm clicks, protocol snapshots, sixty-four-session memory and server switch',
  async () => {
    const home = process.env.SWIFTNEST_CACHE_EVIDENCE_DIR;
    if (!home) throw new Error('Set SWIFTNEST_CACHE_EVIDENCE_DIR to an evidence directory outside the checkout');
    const directory = resolve(home);
    if (directory === resolve('.') || directory.startsWith(`${resolve('.')}/`))
      throw new Error('Evidence must stay outside the checkout');
    await mkdir(directory, { recursive: true });
    const first = new MemoryHarness();
    const second = new MemoryHarness();
    const browser = await launchChromium();
    const context = await browser.newContext({
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
      recordVideo: { dir: directory, size: { width: 1280, height: 900 } },
    });
    const page = await context.newPage();
    const wire: { direction: string; endpoint?: string; type?: string; valueType?: string }[] = [];
    page.on('websocket', (socket) => {
      // Loopback test uses plaintext mux. Save envelope metadata only, never auth or message bodies.
      const record = (direction: string, payload: string | Buffer) => {
        try {
          const frame = JSON.parse(String(payload));
          if (typeof frame.streamId === 'string')
            wire.push({ direction, endpoint: frame.endpoint, type: frame.type, valueType: frame.value?.type });
        } catch {
          /* Not a mux JSON frame. */
        }
      };
      socket.on('framesent', ({ payload }) => record('sent', payload));
      socket.on('framereceived', ({ payload }) => record('received', payload));
    });
    try {
      await first.start();
      await second.start();
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const { sessionId } = await first.client.createSession();
        ids.push(sessionId);
        first.replyText =
          i < 3 ? `${`long-${i} paragraph with readable content.\n\n`.repeat(200)}marker-${i}` : `marker-${i}`;
        const images =
          i === 3 || i === 4
            ? [{ mediaType: 'image/png' as const, data: png(64).toString('base64'), name: `image-${i}.png` }]
            : [];
        await first.turn(sessionId, `prompt-${i}`, images);
      }
      await page.addInitScript(() => {
        localStorage.setItem('swiftnest.locale', 'en');
      });
      await page.goto(webAppUrl(first.kernel!.url, first.kernel!.token, first.kernel!.channelPairing));
      await page.locator('.home-greeting').waitFor();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const memory = async () => {
        const { metrics } = await cdp.send('Performance.getMetrics');
        const system = await browser.newBrowserCDPSession();
        const { processInfo } = await system.send('SystemInfo.getProcessInfo');
        const processes = await Promise.all(
          processInfo.map(async (process) => {
            try {
              const status = await readFile(`/proc/${process.id}/status`, 'utf8');
              return {
                type: process.type,
                pid: process.id,
                rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0),
              };
            } catch {
              return { type: process.type, pid: process.id, rssKiB: null };
            }
          }),
        );
        await system.detach();
        return {
          heapBytes: metrics.find((m) => m.name === 'JSHeapUsedSize')?.value,
          processes,
          rssTotalKiB: processes.reduce((n, p) => n + (p.rssKiB ?? 0), 0),
        };
      };
      const baseline = await memory();
      for (let i = 0; i < 20; i++) await open(page, ids[i]!, `marker-${i}`);
      // Prewarm actual image decoding as well as transcript data.
      for (const i of [3, 4]) {
        await open(page, ids[i]!, `marker-${i}`);
        await expect
          .poll(() =>
            page
              .locator('.transcript img')
              .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete)),
          )
          .toBe(true);
      }
      first.replyText = Array.from({ length: 80 }, (_, i) => `live-${i}`).join(' ');
      first.replyChunkDelayMs = 500;
      await open(page, ids[19]!, 'marker-19');
      await first.client.sendMessage(ids[19]!, 'keep-streaming-during-clicks');
      await page.locator('[data-streaming="true"]').waitFor();
      const before = wire.filter((frame) => frame.direction === 'sent' && frame.endpoint === 'session/follow').length;
      expect(before).toBeGreaterThanOrEqual(20);
      const snapshotBefore = wire.filter((frame) => frame.valueType === 'snapshot').length;
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        // Include actual click dispatch, React commit, layout and two animation frames.
        const elapsed = await page.evaluate(
          ({ id, marker }) =>
            new Promise<number>((resolve, reject) => {
              const link = document.querySelector<HTMLAnchorElement>(`.sidebar a[href="#/chats/${id}"]`);
              if (!link) {
                reject(new Error(`Missing visible navigation for ${id}`));
                return;
              }
              link.scrollIntoView({ block: 'nearest' });
              const start = performance.now();
              link.click();
              const check = () => {
                const list = document.querySelector('.transcript');
                const visible = [...(list?.querySelectorAll('.message__body') ?? [])].some((body) => {
                  const rect = body.getBoundingClientRect();
                  return rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
                });
                if (list?.textContent?.includes(marker) && visible) {
                  requestAnimationFrame(() => resolve(performance.now() - start));
                } else if (performance.now() - start > 5000) reject(new Error(`No content for ${id}`));
                else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            }),
          { id: ids[i]!, marker: i === 19 ? 'live-' : `marker-${i}` },
        );
        times.push(elapsed);
        await page.waitForTimeout(1000);
      }
      const p95 = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!;
      const after = wire.filter((frame) => frame.direction === 'sent' && frame.endpoint === 'session/follow').length;
      const snapshotAfter = wire.filter((frame) => frame.valueType === 'snapshot').length;
      await page.screenshot({ path: join(directory, 'twenty-session-browser.png') });
      expect(after).toBe(before);
      expect(snapshotAfter).toBe(snapshotBefore);
      first.replyChunkDelayMs = 0;
      for (let i = 20; i < 64; i++) {
        const { sessionId } = await first.client.createSession();
        ids.push(sessionId);
        first.replyText = `marker-${i}`;
        await first.turn(sessionId, `prompt-${i}`);
        await open(page, sessionId, `marker-${i}`);
      }
      const loaded = await memory();
      const report = {
        browser: browser.version(),
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        ramBytes: totalmem(),
        viewport: { width: 1280, height: 900 },
        workload: '64 sessions; first three have 200 paragraphs; two have a 64px PNG; one streaming',
        timesMs: times,
        p95Ms: p95,
        followOpensBefore: before,
        followOpensAfter: after,
        snapshotsBefore: snapshotBefore,
        snapshotsAfter: snapshotAfter,
        baseline,
        loaded,
        measurement:
          'Programmatic navigation link clicks to content DOM/layout plus second requestAnimationFrame; not compositor presentation or Android hardware',
      };
      await writeFile(join(directory, 'metrics.json'), JSON.stringify(report, null, 2));
      await writeFile(join(directory, 'protocol-envelopes.json'), JSON.stringify(wire, null, 2));
      console.log('CACHE_ACCEPTANCE_METRICS', JSON.stringify(report));

      // Same renderer/context, second real server under a distinct mount: no page reload can hide cache bugs.
      const target = new URL(second.kernel!.url);
      const { sessionId: otherId } = await second.client.createSession();
      second.replyText = 'second-server-only';
      await second.turn(otherId, 'second-server-prompt');
      await page.route(`${first.kernel!.url}second/**`, async (route) => {
        const url = new URL(route.request().url());
        url.pathname = url.pathname.replace(/^\/second\//, '/');
        url.host = target.host;
        // Streaming SSE must be forwarded, not buffered by route.fetch until teardown.
        if (url.pathname.endsWith('/events')) {
          await route.continue({ url: url.href });
          return;
        }
        const response = await route.fetch({ url: url.href, maxRedirects: 0 });
        await route.fulfill({ response });
      });
      await page.routeWebSocket(`${first.kernel!.url.replace('http:', 'ws:')}second/**`, async (socket) => {
        const url = new URL(socket.url());
        url.pathname = url.pathname.replace(/^\/second\//, '/');
        url.host = target.host;
        const { WebSocket } = createRequire(new URL('../../server/package.json', import.meta.url))('ws');
        const cookies = await context.cookies();
        const upstream = new WebSocket(url.href, {
          headers: { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') },
        });
        const pending: (string | Buffer)[] = [];
        socket.onMessage((message) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
          else pending.push(message);
        });
        upstream.on('open', () => {
          for (const message of pending) upstream.send(message);
        });
        upstream.on('message', (data: Buffer, binary: boolean) => socket.send(binary ? data : data.toString()));
        upstream.on('close', () => socket.close());
        upstream.on('error', () => socket.close());
        socket.onClose(() => upstream.close());
      });
      await page.evaluate(() => {
        location.hash = '/pair';
      });
      await page
        .getByRole('textbox', { name: 'Pairing URL', exact: true })
        .fill(new URL(`second/connect?token=${second.kernel!.token}`, first.kernel!.url).href);
      await page.getByRole('button', { name: 'Pair server', exact: true }).click();
      await page.locator('.home-greeting').waitFor();
      await open(page, otherId, 'second-server-only');
      await page.evaluate((id) => {
        location.hash = `/chats/${id}`;
      }, ids[0]!);
      await expect.poll(() => page.locator('.transcript').innerText()).not.toContain('marker-0');
      await writeFile(
        join(directory, 'server-switch.json'),
        JSON.stringify({ success: true, sameRenderer: true, oldTranscriptAbsent: true }),
      );
      expect(p95).toBeLessThan(100);
    } catch (error) {
      const reason = String(error)
        .split('\n')[0]
        ?.replace(/token(?:=|%3D)[^&\s]+/gi, 'token=REDACTED');
      throw new Error(`${reason}\n${await page.locator('body').innerText()}\n${second.logs.slice(-15).join('\n')}`);
    } finally {
      await context.close();
      await browser.close();
      await first.close();
      await second.close();
    }
  },
  240_000,
);
