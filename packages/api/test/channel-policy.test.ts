import { afterEach, expect, it, vi } from 'vitest';
import { SwiftnestClient } from '../src/index';
import { pairingChannel } from '../src/channel';
import { encodeBytes, type ChannelPairing } from '@swiftnest/channel';

afterEach(() => vi.unstubAllGlobals());

const pin: ChannelPairing = {
  v: 1,
  key: encodeBytes(new Uint8Array(32)),
  addresses: { lan: ['http://192.0.2.1:3077/'], relay: [] },
};
const pairing = (value: unknown) =>
  `http://192.0.2.1:3077/connect?token=secret#sn=${encodeBytes(new TextEncoder().encode(JSON.stringify(value)))}`;

it.each([
  { ...pin, v: 2 },
  { ...pin, key: 'bad' },
  { ...pin, addresses: { lan: ['http://elsewhere/'], relay: [] } },
  { ...pin, addresses: { lan: [...pin.addresses.lan, 'https://user:password@example.test/'], relay: [] } },
  { ...pin, addresses: { lan: [...pin.addresses.lan, 'https://example.test/?token=secret'], relay: [] } },
])('rejects invalid pairing metadata before opening a channel', (value) => {
  expect(() => pairingChannel(new URL(pairing(value)))).toThrow(
    expect.objectContaining({ code: 'channel-key-mismatch' }),
  );
});

it('refuses LAN browser HTTP before sending a token or opening a socket', async () => {
  const fetch = vi.fn();
  const createWebSocket = vi.fn();
  const client = new SwiftnestClient({ cookieMode: 'browser', fetch, createWebSocket });
  await expect(client.connect(pairing(pin))).rejects.toMatchObject({
    code: 'channel-key-mismatch',
    text: { key: 'channelBrowserHttps' },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(createWebSocket).not.toHaveBeenCalled();
});

it('refuses old LAN HTTP links without silently sending the pairing token in plaintext', async () => {
  const fetch = vi.fn();
  const createWebSocket = vi.fn();
  const client = new SwiftnestClient({ cookieMode: 'manual', fetch, createWebSocket });
  await expect(client.connect('http://192.0.2.1:3077/connect?token=secret')).rejects.toMatchObject({
    code: 'channel-key-mismatch',
    text: { key: 'channelPairAgain' },
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(createWebSocket).not.toHaveBeenCalled();
});
