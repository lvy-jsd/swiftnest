import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect } from 'vitest';
import { Perch } from '@swiftnest/core';
import { runLanPerch } from '@swiftnest/link-lan';
import files from '@swiftnest/cap-files';
import { connect, type SwiftnestClient } from '@swiftnest/api';
import { loadConfig } from '../../src/config.js';
import { startKernel, type RunningKernel } from '../../src/kernel.js';
import { pairingUrl } from '../../src/pairing.js';
import { installToolUltra, isBuilt, toolUltraDir, toolUltraPatch } from '../../src/tool-ultra.js';
import { PLUGIN_MANIFEST } from '../../src/plugins.js';
import { scriptedModel } from './tool-ultra-model.js';

export class ToolUltraHarness {
  readonly shared: string;
  readonly script: ReturnType<typeof scriptedModel>;
  readonly model: ReturnType<typeof createServer>;
  readonly log: string[] = [];
  kernel?: RunningKernel;
  client?: SwiftnestClient;
  private perch?: Perch;
  private run?: ReturnType<typeof runLanPerch>;

  constructor(readonly home: string) {
    this.shared = join(home, 'shared');
    this.script = scriptedModel(this.shared);
    this.model = createServer(this.script.handle);
  }

  async start() {
    await mkdir(this.shared);
    await writeFile(join(this.shared, 'hello.txt'), 'hello from the paired Node Perch');
    await new Promise<void>((resolve) => this.model.listen(0, '127.0.0.1', resolve));
    const config = loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: this.home,
      SWIFTNEST_PORT: '0',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
      SWIFTNEST_MODEL_ID: 'fake',
      SWIFTNEST_PLUGINS: PLUGIN_MANIFEST.plugins.filter(({ id }) => id !== 'tool-ultra').map(({ id }) => `${id}=false`).join(','),
      SWIFTNEST_MODEL_BASE_URL: `http://127.0.0.1:${(this.model.address() as AddressInfo).port}/v1`,
    });
    await installToolUltra(config, (line) => this.log.push(line));
    expect(isBuilt(toolUltraDir(config))).toBe(true);
    const math = JSON.parse(await readFile(join(toolUltraDir(config), 'node_modules/mathjs/package.json'), 'utf8'));
    expect(math.version).toBe('15.2.0');
    await installToolUltra(config, (line) => this.log.push(line));
    await this.riskFixture(toolUltraDir(config));
    this.kernel = await startKernel(config, {
      onLine: (line) => this.log.push(line.replace(/token=[^&\s]+/g, 'token=REDACTED')),
    });
    this.client = await connect(pairingUrl(this.kernel.url, this.kernel.token, this.kernel.channelPairing), {
      createWebSocket: (url, { headers }) => new WebSocket(url, { headers }),
    });
    await this.pair();
  }

  private async riskFixture(dir: string) {
    // Harmless high-risk tool: the default gate asks at load time; it never touches files.
    const plugin = join(this.home, 'risk-fixture.mjs');
    await writeFile(
      plugin,
      `export const inject = ['tools'];
      export function apply(ctx) { ctx.tools.register({ name: 'delete_file', description: 'Harmless approval fixture',
        parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => 'fixture only' }); }`,
    );
    const rows = toolUltraPatch(dir) as { insert: { id: string; config: Record<string, unknown> }[] }[];
    const core = rows.flatMap((row) => row.insert).find((row) => row.id === 'tool-manager')!;
    const userRows = [
      { insert: [{ id: 'risk-fixture', name: plugin }] },
      { id: core.id, config: { ...core.config, pinned: ['geo_search'] } },
    ];
    const profile = join(this.home, 'dsh/profiles/swiftnest');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'user.patch.yml'), JSON.stringify(userRows));
  }

  private async pair() {
    const client = this.client!;
    const pairing = await client.createDevicePairing();
    this.perch = await new Perch({ device: 'node' }).use(files, { roots: [this.shared] });
    this.run = runLanPerch(this.perch, {
      url: pairing.url,
      reconnect: false,
      pairing: { code: pairing.code, confirm: async (fp) => fp === pairing.fingerprint },
    });
    await expect.poll(async () => (await client.listDevicePairings()).length).toBe(1);
    await client.confirmDevicePairing((await client.listDevicePairings())[0]!.id, true);
    await expect.poll(async () => (await client.listDevices())[0]?.online).toBe(true);
  }

  async close() {
    this.run?.stop();
    await this.run?.finished;
    await this.perch?.close();
    this.client?.close();
    await this.kernel?.stop();
    await new Promise<void>((resolve) => this.model.close(() => resolve()));
    await rm(this.home, { recursive: true, force: true });
  }
}
