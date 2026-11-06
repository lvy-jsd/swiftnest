/** Real pinned source + kernel + scripted model + paired Node Perch. No credentials. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SwiftnestClient, SwiftnestEvent } from '@swiftnest/api';
import type { RunningKernel } from '../src/kernel.js';
import { webAppUrl } from '../src/pairing.js';
import { ToolUltraHarness } from './fixtures/tool-ultra-harness.js';

type Offered = (kind: string, round: number) => string[];

it.skipIf(process.env.SWIFTNEST_TOOL_ULTRA_E2E !== '1')(
  'installs Tool Ultra, loads paired device tools and delivers risk-gate approvals to the App',
  async () => {
    const harness = new ToolUltraHarness(await mkdtemp(join(tmpdir(), 'swiftnest-ultra-e2e-')));
    try {
      await harness.start();
      await verifyHybridSearch(harness.client!);
      await verifyDevices(harness.client!, harness.script.offered);
      await verifyMedia(harness.client!, harness.script.offered);
      await verifyRiskGate(harness.client!, harness.script.offered);
      const calculated = await turn(harness.client!, 'calculate');
      expect(calculated).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            isError: false,
            text: expect.stringContaining('5.08 cm'),
          }),
        ]),
      );
      if (process.env.SWIFTNEST_WEB_E2E === '1') await browserApproval(harness.kernel!, harness.script.offered);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : error}\n${harness.log.slice(-70).join('\n')}`, {
        cause: error,
      });
    } finally {
      await harness.close();
    }
  },
  240_000,
);

async function verifyHybridSearch(client: SwiftnestClient) {
  const events = await turn(client, 'hybrid-search');
  const listing = events.find((e) => e.type === 'tool-result');
  expect(listing).toBeTruthy();
  expect(String(listing && 'text' in listing ? listing.text : '')).toContain('math_eval');
}

async function verifyDevices(client: SwiftnestClient, offered: Offered) {
  const loaded = await turn(client, 'load-device');
  expect(offered('load-device', 0)).toEqual(expect.arrayContaining(['tools_ls', 'tools_load', 'geo_search']));
  expect(offered('load-device', 0).filter((n) => n.startsWith('device__'))).toEqual([]);
  expect(offered('load-device', 2)).toContain('device__node__files_read');
  expect(loaded).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'tool-result',
        isError: false,
        text: expect.stringContaining('hello from the paired Node Perch'),
      }),
    ]),
  );
}

async function verifyRiskGate(client: SwiftnestClient, offered: Offered) {
  const denied = await turn(client, 'risk-deny', 'rejected');
  expect(denied.some((e) => e.type === 'approval-request' && e.toolName === 'tools_load')).toBe(true);
  expect(offered('risk-deny', 1)).not.toContain('delete_file');
  const allowed = await turn(client, 'risk-allow', 'allowed-once');
  expect(allowed.some((e) => e.type === 'approval-request' && e.reason?.includes('delete_file'))).toBe(true);
  expect(offered('risk-allow', 1)).toContain('delete_file');
}

async function turn(client: SwiftnestClient, prompt: string, answer?: 'rejected' | 'allowed-once') {
  const { sessionId } = await client.createSession();
  const sub = await client.follow(sessionId, { signal: AbortSignal.timeout(20_000) });
  const events: SwiftnestEvent[] = [];
  const done = (async () => {
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'approval-request' && answer) await client.answerApproval(event.requestId, answer);
      if (event.type === 'turn-end') break;
    }
  })();
  try {
    await client.sendMessage(sessionId, prompt);
    await done;
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    return events;
  } finally {
    sub.close();
  }
}

async function browserApproval(kernel: RunningKernel, offered: Offered) {
  const { launchChromium } = await import('../../client/test/browser.js');
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem('swiftnest.locale', 'en'));
    await page.goto(webAppUrl(kernel.url, kernel.token, kernel.channelPairing));
    for (const [prompt, answer] of [
      ['risk-browser-deny', 'Deny'],
      ['risk-browser-allow', 'Approve'],
    ] as const) {
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await page.getByRole('textbox', { name: 'Write a message' }).fill(prompt);
      await page.getByRole('button', { name: 'Send message' }).click();
      const card = page.getByRole('article', { name: 'Allow this tool request?' });
      await card.getByText('tools_load', { exact: true }).waitFor();
      expect(offered(prompt, 1)).not.toContain('delete_file');
      await card.getByRole('button', { name: answer, exact: true }).click();
      await card.getByText('This approval request has ended.').waitFor();
      await expect.poll(() => offered(prompt, 1).includes('delete_file')).toBe(answer === 'Approve');
      await page.getByRole('list', { name: 'Messages', exact: true }).getByText('Done.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Go back', exact: true }).click();
    }
  } finally {
    await browser.close();
  }
}

async function verifyMedia(client: SwiftnestClient, offered: Offered) {
  for (const kind of ['chart', 'html']) {
    const prompt = `media-${kind}`;
    const events = await turn(client, prompt);
    expect(offered(prompt, 1)).toContain(`${kind}_render`);
    await verifyMediaDownload(client, events);
  }
}

async function verifyMediaDownload(client: SwiftnestClient, events: SwiftnestEvent[]) {
  const result = events.find((event) => event.type === 'tool-result' && event.attachments?.length);
  expect(result, JSON.stringify(events)).toMatchObject({
    isError: false,
    attachments: [{ path: expect.stringMatching(/^media\/.*\.png$/u) }],
  });
  if (result?.type !== 'tool-result') throw new Error('Missing generated attachment');
  const blob = await client.downloadFile(result.attachments![0]!.path);
  expect(blob.type).toBe('image/png');
  expect(blob.size).toBeGreaterThan(100);
}
