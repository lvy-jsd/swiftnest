import type { ServerConfig } from '../../src/config.js';
import { startKernel, type StartOptions } from '../../src/kernel.js';

/** Let DSH reserve its own test port, then keep that origin (and its cookies) across restarts. */
export function startStableKernel(config: ServerConfig, options: StartOptions = {}) {
  const stable = { ...config, port: 0 };
  return startKernel(stable, {
    ...options,
    onReady(kernel) {
      stable.port = Number(new URL(kernel.url).port);
      options.onReady?.(kernel);
    },
  });
}
