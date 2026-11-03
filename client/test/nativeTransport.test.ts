import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Message } from '@tauri-apps/plugin-websocket';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), connect: vi.fn(), invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.fetch }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: mocks.connect } }));
import { NativeSocket, nativeOptions } from '../src/nativeTransport';

afterEach(() => vi.resetAllMocks());
function socket() {
  let listener: (message: Message) => void = () => {};
  const unlisten = vi.fn();
  const value = {
    send: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    addListener: vi.fn((callback: typeof listener) => {
      listener = callback;
      return unlisten;
    }),
  };
  mocks.connect.mockResolvedValue(value);
  return { value, unlisten, receive: (message: Message) => listener(message) };
}
describe('native transport adapter', () => {
  it('uses manual cookies, preserves Cookie, suppresses WebView Origin and disables all redirects', async () => {
    mocks.fetch.mockResolvedValue(new Response('ok'));
    const options = nativeOptions();
    expect(options.cookieMode).toBe('manual');
    await options.fetch!('http://192.168.1.2:3077/connect?token=test', {
      redirect: 'manual',
      headers: { cookie: 'api=signed' },
    });
    const init = mocks.fetch.mock.calls[0]![1] as RequestInit & { maxRedirections: number };
    expect(init.maxRedirections).toBe(0);
    expect(new Headers(init.headers).get('cookie')).toBe('api=signed');
    expect(new Headers(init.headers).get('origin')).toBe('');
  });
  it('opens asynchronously with Cookie, orders writes, forwards text/close, and removes listeners', async () => {
    const mock = socket();
    const ws = new NativeSocket('ws://lan:3077/api/remote.mux', { cookie: 'api=signed' });
    const open = vi.fn(),
      message = vi.fn(),
      closed = vi.fn();
    ws.addEventListener('open', open, { once: true });
    ws.addEventListener('message', message);
    ws.addEventListener('close', closed);
    await vi.waitFor(() => expect(ws.readyState).toBe(1));
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith('ws://lan:3077/api/remote.mux', { headers: { cookie: 'api=signed' } });
    ws.send('first');
    ws.send('second');
    await vi.waitFor(() => expect(mock.value.send.mock.calls).toEqual([['first'], ['second']]));
    mock.receive({ type: 'Text', data: 'frame' });
    expect(message).toHaveBeenCalledWith({ data: 'frame' });
    ws.removeEventListener('message', message);
    mock.receive({ type: 'Text', data: 'ignored' });
    expect(message).toHaveBeenCalledOnce();
    mock.receive({ type: 'Close', data: null });
    expect(ws.readyState).toBe(3);
    expect(closed).toHaveBeenCalledOnce();
    expect(mock.unlisten).toHaveBeenCalledOnce();
    ws.close();
    expect(mock.value.disconnect).toHaveBeenCalledOnce();
  });
  it('disposes a connection that resolves after cancellation', async () => {
    const mock = socket();
    const ws = new NativeSocket('wss://host/api/remote.mux', {});
    const open = vi.fn();
    ws.addEventListener('open', open);
    ws.close();
    await vi.waitFor(() => expect(mock.value.disconnect).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    expect(mock.value.addListener).not.toHaveBeenCalled();
  });
  it('reports connect and async write failures as socket errors', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('failed'));
    const ws = new NativeSocket('ws://host/api/remote.mux', {});
    const error = vi.fn();
    ws.addEventListener('error', error);
    await vi.waitFor(() => expect(ws.readyState).toBe(3));
    expect(error).toHaveBeenCalledOnce();
    const mock = socket();
    mock.value.send.mockRejectedValueOnce(new Error('send failed'));
    const writing = new NativeSocket('ws://host/api/remote.mux', {});
    writing.addEventListener('error', error);
    await vi.waitFor(() => expect(writing.readyState).toBe(1));
    writing.send('request');
    await vi.waitFor(() => expect(writing.readyState).toBe(3));
    expect(error).toHaveBeenCalledTimes(2);
  });
});

it('uses the private native store scoped to the server root, including explicit deletion', async () => {
  const storage = nativeOptions().nativePairingStore!;
  mocks.invoke.mockResolvedValueOnce('x'.repeat(43));
  expect(await storage.load('https://server/')).toBe('x'.repeat(43));
  expect(mocks.invoke).toHaveBeenLastCalledWith('app_pairing_load', { root: 'https://server/' });
  await storage.save('https://server/', 'y'.repeat(43));
  expect(mocks.invoke).toHaveBeenLastCalledWith('app_pairing_save', {
    root: 'https://server/',
    credential: 'y'.repeat(43),
  });
  await storage.save('https://server/', undefined);
  expect(mocks.invoke).toHaveBeenLastCalledWith('app_pairing_save', { root: 'https://server/', credential: null });
  mocks.invoke.mockResolvedValueOnce(null);
  expect(await storage.load('https://other/')).toBeUndefined();
});

it('allows the native pairing, chat and device-binding workflow through explicit Tauri HTTP paths', () => {
  const capability = JSON.parse(
    readFileSync(new URL('../src-tauri/capabilities/default.json', import.meta.url), 'utf8'),
  );
  const http = capability.permissions.find((p: any) => p.identifier === 'http:default');
  const paths = new Set(
    http.allow.map((p: { url: string }) => new URL(p.url.replace('://*:*', '://server:3077')).pathname),
  );
  for (const path of [
    '/swiftnest/native/issue',
    '/swiftnest/native/resume',
    '/swiftnest/native/rotate',
    '/swiftnest/native/bind',
    '/swiftnest/native/revoke',
    '/swiftnest/api/chat',
    '/swiftnest/api/devices',
    '/swiftnest/api/devices/approvals',
    '/swiftnest/api/devices/pairing',
    '/swiftnest/api/devices/transfers',
    '/swiftnest/api/devices/revoke/*',
  ])
    expect(paths.has(path)).toBe(true);
  expect(paths.has('/swiftnest/*')).toBe(false);
  expect(paths.has('/swiftnest/native/*')).toBe(false);
  expect([...paths].some((p) => String(p).startsWith('/swiftnest/control'))).toBe(false);
});
