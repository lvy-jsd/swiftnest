/** Run cargo build -p swiftnest-perch --example interop, then SWIFTNEST_PERCH_E2E=1 pnpm test. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Nest, silentLogger } from '@swiftnest/core';
import { serveLan } from '@swiftnest/link-lan';
import { filesCapability } from '@swiftnest/cap-files';
import { shellCapability } from '@swiftnest/cap-shell';

it('Rust tool manifests match the TS capability schemas and limits', async () => {
  for (const [id, capability] of [
    ['files', filesCapability()],
    ['shell', shellCapability()],
  ] as const) {
    const manifest = JSON.parse(await readFile(new URL(`../src/manifests/${id}.json`, import.meta.url), 'utf8'));
    expect(manifest.tools).toEqual(
      capability.manifest.tools.map((tool) => ({ ...tool, defaultTimeoutMs: tool.defaultTimeoutMs ?? 30000 })),
    );
  }
});

it.skipIf(process.env.SWIFTNEST_PERCH_E2E !== '1')(
  'TS Nest ↔ Rust Perch: code, fingerprints, tools, approval, cancel, reconnect, pin and unpair',
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'perch-interop-'));
    const root = join(home, 'shared');
    await mkdir(root);
    await writeFile(join(root, 'a.txt'), 'hello');
    const nest = new Nest({ logger: silentLogger });
    let lan = await serveLan(nest, { host: '127.0.0.1', port: 0, advertise: false });
    const port = lan.port;
    let child: ChildProcessWithoutNullStreams | undefined;
    const states: any[] = [];
    const errors: string[] = [];
    const launch = () => {
      child = spawn(fileURLToPath(new URL('../../../target/debug/examples/interop', import.meta.url)), [
        join(home, 'state'),
      ]);
      createInterface({ input: child.stdout }).on('line', (line) => {
        states.push(JSON.parse(line));
      });
      child.stderr.on('data', (line) => errors.push(String(line)));
    };
    const send = (value: unknown) => child!.stdin.write(`${JSON.stringify(value)}\n`);
    const wait = (condition: () => boolean) =>
      expect.poll(condition, { timeout: 15000, message: errors.join('\n') }).toBe(true);
    const last = () => states.at(-1);
    try {
      const { code } = nest.pairing.start();
      launch();
      await wait(() => !!last()?.settings);
      send({
        op: 'start',
        settings: { ...last().settings, name: 'Rust laptop', enabled: true, roots: [root], url: lan.url },
        code,
      });
      await wait(() => last()?.confirmationPending === true);
      expect(last().nestFingerprint).toBe(nest.identity.fingerprint);
      await wait(() => nest.pairing.pending().length === 1);
      expect(nest.pairing.pending()[0]!.fingerprint).toBe(last().fingerprint);
      send({ op: 'confirm', accept: true });
      nest.pairing.confirm(nest.pairing.pending()[0]!.id, true);
      await wait(() => last()?.phase === 'online' && nest.devices().length === 1);
      const device = nest.devices()[0]!.device;
      expect(nest.devicesStore.get(device)?.name).toBe('Rust laptop');
      expect(nest.tools().map((t) => t.name)).toContain(`${device}__files__read`);
      expect(nest.tools()).toHaveLength(19);
      const slug = nest.devicesStore.get(device)!.slug;
      send({ op: 'start', settings: { ...last().settings, name: 'Renamed Rust laptop' } });
      await wait(() => last()?.phase === 'online' && nest.devicesStore.get(device)?.name === 'Renamed Rust laptop');
      expect(nest.devicesStore.get(device)!.slug).toBe(slug);
      const call = (cap: string, tool: string, args: Record<string, unknown>, ms?: number) =>
        nest.call(`${device}__${cap}__${tool}`, args, { id: 'interop' }, ms);
      const read = await call('files', 'read', { path: 'a.txt' });
      expect((await nest.tasks.wait(read.id, 5000)).result?.text).toBe('hello');
      const write = await call('files', 'write', { path: 'b.txt', content: 'approved' });
      expect(write.state).toBe('pending_approval');
      await expect(readFile(join(root, 'b.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await nest.tasks.approve(write.id);
      expect((await nest.tasks.wait(write.id, 5000)).state).toBe('succeeded');
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('approved');
      const shell = await call('shell', 'run', { command: 'echo hello' });
      expect((await nest.tasks.wait(shell.id, 5000)).result?.text).toBe('hello');
      const cancel = await call('shell', 'run', { command: 'sleep 2; echo late > late' }, 10000);
      expect(cancel.state).toBe('pending_approval');
      await nest.tasks.approve(cancel.id);
      await new Promise((r) => setTimeout(r, 200));
      await nest.tasks.cancel(cancel.id);
      expect((await nest.tasks.wait(cancel.id, 5000)).state).toBe('cancelled');
      const timed = await call('shell', 'run', { command: 'sleep 5' }, 150);
      await nest.tasks.approve(timed.id);
      expect((await nest.tasks.wait(timed.id, 5000)).state).toBe('timed_out');
      const disableTask = await call('shell', 'run', { command: 'sleep 2; echo late > after-off' }, 10000);
      await nest.tasks.approve(disableTask.id);
      await new Promise((r) => setTimeout(r, 200));
      send({ op: 'disable' });
      await wait(() => last()?.settings.enabled === false && nest.devices().length === 0);
      expect(last().settings.nestKey).toBeTruthy();
      send({ op: 'start', settings: { ...last().settings, enabled: true } });
      await wait(() => last()?.phase === 'online' && nest.devices().length === 1);
      await lan.close();
      await wait(() => nest.devices().length === 0);
      lan = await serveLan(nest, { host: '127.0.0.1', port, advertise: false });
      await wait(() => last()?.phase === 'online' && nest.devices().length === 1);
      expect(nest.pairing.pending()).toHaveLength(0);
      // A process restart uses the same identity and pinned Nest without another code.
      send({ op: 'quit' });
      await new Promise((resolve) => child!.once('exit', resolve));
      states.length = 0;
      launch();
      await wait(() => !!last()?.settings);
      send({ op: 'start', settings: last().settings });
      await wait(() => last()?.phase === 'online');
      expect(nest.devices()[0]!.device).toBe(device);
      expect(nest.pairing.pending()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 2200));
      await expect(readFile(join(root, 'late'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(root, 'after-off'))).rejects.toMatchObject({ code: 'ENOENT' });
      // A different Nest at the saved address is rejected before tools are announced.
      await lan.close();
      const imposter = new Nest({ logger: silentLogger });
      // Allow its early screen so the Rust side actually sees and checks the changed key.
      await imposter.devicesStore.add({ ...nest.devicesStore.get(device)! });
      lan = await serveLan(imposter, { host: '127.0.0.1', port, advertise: false });
      await wait(() => last()?.error?.code === 'NEST_KEY_CHANGED');
      expect(imposter.devices()).toHaveLength(0);
      send({ op: 'unpair' });
      await wait(() => last()?.settings.nestKey === null && last()?.settings.enabled === false);
      await imposter.close();
    } finally {
      child?.stdin.end();
      child?.kill();
      await lan.close();
      await nest.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
