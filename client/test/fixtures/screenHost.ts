import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { expect } from 'vitest';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV } from '../../../server/src/devices.js';
import { loadConfig } from '../../../server/src/config.js';
import { deviceProxy, liveUpgrade } from '../../../server/bundle/src/devices.js';

/** Isolated real compositor + paired Rust Perch; never injects into the user's desktop. */
export async function startScreenFixture() {
  const home = await mkdtemp(join(tmpdir(), 'perch-screen-'));
  const runtime = join(home, 'runtime');
  await mkdir(runtime, { mode: 0o700 });
  const config = join(home, 'config');
  await mkdir(config);
  const processes: ChildProcessWithoutNullStreams[] = [];
  const errors: string[] = [];
  const launch = (bin: string, args: string[], env = process.env) => {
    const child = spawn(bin, args, { env });
    processes.push(child);
    child.stderr.on('data', (data) => errors.push(String(data)));
    return child;
  };
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_HOME: config,
    WLR_BACKENDS: 'headless',
    WLR_HEADLESS_OUTPUTS: '1',
    WLR_RENDERER: 'pixman',
    LIBGL_ALWAYS_SOFTWARE: '1',
    DBUS_SESSION_BUS_ADDRESS: '',
    WAYLAND_DISPLAY: '',
    DISPLAY: '',
  };
  const hub = await startDevices(
    loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: join(home, 'server'),
      SWIFTNEST_DEVICES_HOST: '127.0.0.1',
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
    }),
  );
  const admission = {
    admit: (req: { headers: import('node:http').IncomingHttpHeaders }) =>
      req.headers.authorization === 'Bearer owner-session'
        ? { peer: { principal: { kind: 'owner' } } }
        : { rejection: 403 },
  };
  const handler = deviceProxy(admission, hub.env[ADMIN_URL_ENV], hub.env[ADMIN_TOKEN_ENV]);
  const upgrade = liveUpgrade(admission, hub.env[ADMIN_URL_ENV], hub.env[ADMIN_TOKEN_ENV]);
  const app = createServer((req, res) => void handler(req, res));
  app.on('upgrade', upgrade.handler);
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  try {
    launch('labwc', ['-d', '-C', config], env);
    await expect
      .poll(async () => (await readdir(runtime)).some((f) => /^wayland-\d+$/.test(f)), {
        timeout: 10000,
        message: errors.join('\n'),
      })
      .toBe(true);
    env.WAYLAND_DISPLAY = (await readdir(runtime)).find((f) => /^wayland-\d+$/.test(f))!;
    const fixture = launch(resolve('target/debug/examples/screen_fixture'), [], env);
    const clicks: any[] = [];
    let fixtureReady = false;
    createInterface({ input: fixture.stdout }).on('line', (line) => {
      const v = JSON.parse(line);
      if (v.ready) fixtureReady = true;
      if (v.click) clicks.push(v);
    });
    await expect.poll(() => fixtureReady, { timeout: 10000, message: errors.join('\n') }).toBe(true);
    const child = launch(resolve('target/debug/examples/interop'), [join(home, 'state')], env);
    const states: any[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => states.push(JSON.parse(line)));
    const send = (data: unknown) => child.stdin.write(JSON.stringify(data) + '\n');
    const last = () => states.at(-1);
    await expect.poll(() => !!last()?.settings).toBe(true);
    const { code } = hub.nest.pairing.start();
    send({ op: 'start', settings: { ...last().settings, enabled: true, roots: [home], url: hub.lanUrl }, code });
    await expect.poll(() => last()?.confirmationPending).toBe(true);
    send({ op: 'confirm', accept: true });
    await expect.poll(() => hub.nest.pairing.pending().length).toBe(1);
    hub.nest.pairing.confirm(hub.nest.pairing.pending()[0]!.id, true);
    await expect.poll(() => hub.nest.devices().length).toBe(1);
    return { home, hub, appUrl, clicks, errors, send, last, close };
  } catch (error) {
    await close();
    throw new Error(String(error) + '\n' + errors.slice(-15).join('\n'), { cause: error });
  }
  async function close() {
    for (const child of processes.reverse()) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
    await Promise.all(
      processes.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise((r) => child.once('exit', r)),
      ),
    );
    upgrade.close();
    await hub.close();
    await new Promise<void>((r) => {
      app.close(() => r());
      app.closeAllConnections();
    });
    await rm(home, { recursive: true, force: true });
  }
}
