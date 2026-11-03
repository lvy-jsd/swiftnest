import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
it('defaults relay off and accepts an explicit HTTPS address and strong secret', () => {
  expect(loadConfig(undefined, {}).relay).toBeUndefined();
  expect(
    loadConfig(undefined, { SWIFTNEST_RELAY_ADDRESS: 'https://relay.example/', SWIFTNEST_RELAY_SECRET: 's'.repeat(32) })
      .relay,
  ).toEqual({ address: 'https://relay.example/', secret: 's'.repeat(32) });
});
it.each([
  'http://public.example/',
  'https://user:pass@relay.example/',
  'https://relay.example/?secret=x',
  'https://relay.example/path',
])('rejects unsafe relay address %s', (address) => {
  expect(() =>
    loadConfig(undefined, { SWIFTNEST_RELAY_ADDRESS: address, SWIFTNEST_RELAY_SECRET: 's'.repeat(32) }),
  ).toThrow();
});
it('rejects a missing or short secret', () => {
  expect(() => loadConfig(undefined, { SWIFTNEST_RELAY_ADDRESS: 'https://relay.example/' })).toThrow();
});
