import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Perch, memoryLink } from '@swiftnest/core';
import files from '@swiftnest/cap-files';
import { startDevices, ADMIN_TOKEN_ENV, ADMIN_URL_ENV } from '../../src/devices.js';
import { loadConfig } from '../../src/config.js';
import { apply, type NativeToolDefinition, type SwiftnestDevices } from '../src/native-devices.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(catalog = true) {
  let catalogAvailable = catalog;
  let catalogReady: ((ctx: any) => void) | undefined;
  const home = await mkdtemp(join(tmpdir(), 'native-devices-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const hub = await startDevices(
    loadConfig(undefined, {
      SWIFTNEST_LANG: 'en',
      SWIFTNEST_HOME: home,
      SWIFTNEST_DEVICES_PORT: '0',
      SWIFTNEST_DEVICES_MDNS: 'false',
    }),
  );
  cleanup.push(hub.close);
  const tools = new Map<string, NativeToolDefinition>();
  const registered = vi.fn((tool: NativeToolDefinition) => {
    tools.set(tool.name, tool);
    return () => {
      tools.delete(tool.name);
    };
  });
  let service!: SwiftnestDevices;
  const emit = vi.fn();
  const annotate = vi.fn();
  const routes: any[] = [];
  const admit = vi.fn().mockReturnValue({ peer: { principal: { kind: 'owner' } } });
  const invoke = vi.fn(async (request: any) => {
    expect(service.currentFor(request.args.request.sessionId)).toBe(
      request.args.request.requestId === 'native' ? 'laptop' : undefined,
    );
    return { accepted: true };
  });
  const disposers: (() => void)[] = [];
  await apply(
    {
      tools: { register: registered },
      connection: { admit },
      webServer: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
      typertGateway: { invoke },
      provide: (name, value) => {
        expect(name).toBe('swiftnestDevices');
        service = value;
      },
      inject: (_deps, fn) => {
        catalogReady = fn;
      },
      emit,
      get: () => (catalogAvailable ? { annotate } : undefined),
      effect: (fn) => {
        disposers.push(fn());
      },
      logger: { warn: vi.fn() },
    },
    { devicesAdminUrl: hub.env[ADMIN_URL_ENV], devicesAdminToken: hub.env[ADMIN_TOKEN_ENV] },
  );
  cleanup.push(() => {
    for (const dispose of disposers.reverse()) dispose();
  });
  return {
    hub,
    home,
    tools,
    registered,
    service,
    emit,
    annotate,
    routes,
    admit,
    invoke,
    addCatalog: () => {
      catalogAvailable = true;
      catalogReady?.({
        get: () => ({ annotate }),
        effect: (fn) => {
          disposers.push(fn());
        },
      });
    },
  };
}
async function pair(t: Awaited<ReturnType<typeof setup>>) {
  const perch = await new Perch({ device: 'laptop', kind: 'android' }).use(files, { roots: [t.home] });
  cleanup.push(() => perch.close());
  await t.hub.nest.devicesStore.add({
    device: perch.device,
    kind: perch.kind,
    publicKey: perch.identity.publicKey,
    pairedAt: new Date().toISOString(),
  });
  await expect.poll(() => t.service.list().length).toBe(1);
  expect(t.emit).toHaveBeenCalledWith('swiftnest/devices-changed', { slugs: ['laptop'] });
  t.hub.nest.attach(memoryLink(perch));
  await expect.poll(() => t.tools.has('device__laptop__files_read')).toBe(true);
  return perch;
}

it('provides list/currentFor, emits pairing/online/offline/revocation, retains tools offline, and annotates the catalog', async () => {
  const t = await setup();
  await pair(t);
  expect(t.service.list()).toMatchObject([
    { slug: 'laptop', name: 'laptop', kind: 'android', online: true, lastSeen: expect.any(String) },
  ]);
  const copy = t.service.list();
  copy[0]!.name = 'mutated';
  expect(t.service.list()[0]!.name).toBe('laptop');
  expect(t.service.currentFor('unknown')).toBeUndefined();
  expect(t.annotate).toHaveBeenCalledWith('device__laptop__files_read', {
    category: 'device',
    group: 'laptop',
    risk: 'read',
    summary: expect.any(String),
  });
  expect(t.annotate).toHaveBeenCalledWith('device__laptop__files_write', expect.objectContaining({ risk: 'write' }));
  const count = t.registered.mock.calls.length;
  t.emit.mockClear();
  t.hub.nest.detach('laptop');
  await expect.poll(() => t.service.list()[0]?.online).toBe(false);
  expect(t.emit).toHaveBeenCalledWith('swiftnest/devices-changed', { slugs: ['laptop'] });
  expect(t.registered).toHaveBeenCalledTimes(count);
  expect(t.tools.has('device__laptop__files_read')).toBe(true);
  await expect(
    t.tools.get('device__laptop__files_read')!.execute({ path: 'anything' }, { signal: new AbortController().signal }),
  ).rejects.toThrow(/^device laptop is offline \(last seen \d{4}-.*Z\)$/);
  t.emit.mockClear();
  await t.hub.nest.revoke('laptop');
  await expect.poll(() => t.service.list()).toEqual([]);
  expect([...t.tools.keys()].sort()).toEqual(['transfer_cancel', 'transfer_file', 'transfer_status']);
  expect(t.emit).toHaveBeenCalledWith('swiftnest/devices-changed', { slugs: ['laptop'] });
});

it('silently supports no catalog, waits through approval, returns denial, and cancels an aborted call', async () => {
  const t = await setup(false);
  await pair(t);
  await writeFile(join(t.home, 'read'), 'hello');
  const exec = { signal: new AbortController().signal, agent: { id: 'chat-1' } };
  expect(await t.tools.get('device__laptop__files_read')!.execute({ path: join(t.home, 'read') }, exec)).toMatchObject({
    text: expect.stringContaining('hello'),
  });
  const write = t.tools.get('device__laptop__files_write')!;
  let finished = false;
  const pending = write.execute({ path: join(t.home, 'write'), content: 'approved' }, exec).finally(() => {
    finished = true;
  });
  await expect.poll(() => t.hub.nest.tasks.list({ state: 'pending_approval' }).length).toBe(1);
  expect(finished).toBe(false);
  const task = t.hub.nest.tasks.list({ state: 'pending_approval' })[0]!;
  expect(task.client.id).toBe('dsh:chat-1');
  await t.hub.nest.tasks.approve(task.id);
  await pending;
  expect(await readFile(join(t.home, 'write'), 'utf8')).toBe('approved');
  const denied = write.execute({ path: join(t.home, 'write'), content: 'denied' }, exec);
  const denial = expect(denied).rejects.toThrow('denied by owner');
  await expect.poll(() => t.hub.nest.tasks.list({ state: 'pending_approval' }).length).toBe(1);
  await t.hub.nest.tasks.deny(t.hub.nest.tasks.list({ state: 'pending_approval' })[0]!.id);
  await denial;
  const abort = new AbortController();
  const cancelled = expect(
    write.execute({ path: join(t.home, 'write'), content: 'cancelled' }, { signal: abort.signal }),
  ).rejects.toThrow();
  await expect.poll(() => t.hub.nest.tasks.list({ state: 'pending_approval' }).length).toBe(1);
  // Allow the submit acknowledgement to reach the bridge before cancelling its wait.
  await vi.waitFor(() => expect(t.hub.nest.tasks.list().at(-1)?.state).toBe('pending_approval'));
  abort.abort();
  await cancelled;
  await expect.poll(() => t.hub.nest.tasks.list().at(-1)?.state).toBe('cancelled');
  expect(await readFile(join(t.home, 'write'), 'utf8')).toBe('approved');
  expect([...t.tools.keys()].some((n) => /task_|approv/.test(n))).toBe(false);
});

it('tracks the actual owner App prompt before gateway dispatch and clears origin for web chat', async () => {
  const t = await setup();
  await pair(t);
  const server = createServer((req, res) => void t.routes[0].handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    const done = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await done;
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/swiftnest/api/chat`;
  const send = (deviceSlug?: string, requestId = 'web') =>
    fetch(url, { method: 'POST', body: JSON.stringify({ deviceSlug, request: { sessionId: 'chat', requestId } }) });
  t.admit.mockReturnValue({ rejection: 401 });
  expect((await send()).status).toBe(401);
  t.admit.mockReturnValue({ peer: { principal: { kind: 'agent' } } });
  expect((await send()).status).toBe(403);
  t.admit.mockReturnValue({ peer: { principal: { kind: 'owner' } } });
  expect((await send('laptop', 'native')).status).toBe(200);
  expect(t.service.currentFor('chat')).toBe('laptop');
  expect((await send('unknown')).status).toBe(400);
  expect(t.service.currentFor('chat')).toBe('laptop');
  expect((await send()).status).toBe(200);
  expect(t.service.currentFor('chat')).toBeUndefined();
  let rejectOld!: () => void;
  const oldPrompt = new Promise<void>((resolve) => {
    rejectOld = resolve;
  });
  let started = false;
  t.invoke.mockImplementationOnce(async () => {
    started = true;
    await oldPrompt;
    throw new Error('rejected prompt');
  });
  const oldResponse = send('laptop', 'native');
  await expect.poll(() => started).toBe(true);
  expect((await send()).status).toBe(200);
  rejectOld();
  expect((await oldResponse).status).toBe(400);
  expect(t.service.currentFor('chat')).toBeUndefined();
  expect((await send('laptop', 'native')).status).toBe(200);
  await t.hub.nest.revoke('laptop');
  await expect.poll(() => t.service.currentFor('chat')).toBeUndefined();
});

it('annotates tools when an optional catalog appears after registration', async () => {
  const t = await setup(false);
  await pair(t);
  expect(t.annotate).not.toHaveBeenCalled();
  t.addCatalog();
  expect(t.annotate).toHaveBeenCalledWith(
    'device__laptop__files_read',
    expect.objectContaining({ category: 'device', group: 'laptop', risk: 'read' }),
  );
});

it('keeps one catalog annotation per tool across reconnects', async () => {
  const t = await setup();
  const live = new Map<string, number>();
  t.annotate.mockImplementation((name: string) => {
    live.set(name, (live.get(name) ?? 0) + 1);
    return () => live.set(name, live.get(name)! - 1);
  });
  const perch = await pair(t);
  t.hub.nest.detach(perch.device);
  await expect.poll(() => t.service.list()[0]?.online).toBe(false);
  t.hub.nest.attach(memoryLink(perch));
  await expect.poll(() => t.service.list()[0]?.online).toBe(true);
  expect(Math.max(...live.values())).toBe(1);
  await t.hub.nest.revoke('laptop');
  await expect.poll(() => t.tools.has('device__laptop__files_read')).toBe(false);
  expect(live.get('device__laptop__files_read')).toBe(0);
});

it('cancels a call aborted before its submit acknowledgement arrives', async () => {
  const t = await setup(false);
  const perch = await pair(t);
  const original = perch.classify.bind(perch);
  let classifyStarted = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(perch, 'classify').mockImplementation(async (...args) => {
    classifyStarted = true;
    await gate;
    return original(...args);
  });
  const abort = new AbortController();
  const failed = expect(
    t.tools
      .get('device__laptop__files_write')!
      .execute({ path: join(t.home, 'late-write'), content: 'never' }, { signal: abort.signal }),
  ).rejects.toThrow();
  await expect.poll(() => classifyStarted).toBe(true);
  abort.abort();
  await failed;
  release();
  await expect.poll(() => t.hub.nest.tasks.list().at(-1)?.state).toBe('cancelled');
  await expect(readFile(join(t.home, 'late-write'))).rejects.toMatchObject({ code: 'ENOENT' });
});
