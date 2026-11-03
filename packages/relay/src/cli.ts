#!/usr/bin/env node
import { render, text } from '@swiftnest/protocol';
import { startRelay } from './index.js';
try {
  const relay = await startRelay({
    trustedProxyIp: process.env.SWIFTNEST_RELAY_TRUST_PROXY,
    secret: process.env.SWIFTNEST_RELAY_SECRET ?? '',
    host: process.env.SWIFTNEST_RELAY_HOST ?? '127.0.0.1',
    port: Number(process.env.SWIFTNEST_RELAY_PORT ?? 8787),
  });
  process.stdout.write(`${render(text('relayStarted'))}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void relay.close();
    });
} catch {
  process.stderr.write(`${render(text('relayStartFailed'))}\n`);
  process.exitCode = 1;
}
