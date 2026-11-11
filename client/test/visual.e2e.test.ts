/**
 * The visual-regression gate.
 *
 * The spec, its four breakpoints, its masks and the per-platform baselines
 * (scripts/visual/screenshots/web) live in scripts/visual. Playwright's
 * snapshot service — `toHaveScreenshot` and the expected/actual/diff PNGs —
 * only exists inside its own runner, so this test runs that runner instead of
 * re-implementing the image comparison here.
 *
 * Opt-in with SWIFTNEST_WEB_E2E=1 like every other browser test in this
 * directory: the e2e step that sets it is also the one that builds client/dist
 * and installs Chromium, both of which the screenshot run needs.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);

it.skipIf(process.env.SWIFTNEST_WEB_E2E !== '1')(
  'visual regression: web baselines match',
  async () => {
    expect(
      existsSync(join(root, 'client/dist/index.html')),
      'The screenshot run serves the built App: run pnpm --filter ./client build:web first',
    ).toBe(true);

    // Resolve through the workspace so the CLI and its browser build match the
    // pinned @playwright/test in client/package.json.
    const cli = require.resolve('@playwright/test/cli');
    const result = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [cli, 'test', '--config', join(root, 'scripts/visual/playwright.config.ts'), '--reporter=line'],
        {
          cwd: join(root, 'scripts/visual'),
          env: { ...process.env, FORCE_COLOR: '0' },
        },
      );
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output += String(chunk);
      });
      child.on('close', (code) => resolve({ code, output }));
    });

    // The reporter output names every mismatching shot and the actual/diff PNGs
    // under scripts/visual/test-results, so a failure here reads like a normal
    // Playwright failure rather than an exit code.
    expect(result.code, result.output).toBe(0);
  },
  600_000,
);
