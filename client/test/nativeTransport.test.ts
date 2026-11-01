import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@tauri-apps/plugin-websocket';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), connect: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: mocks.fetch }));
vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: mocks.connect } }));
import { NativeSocket, nativeOptions } from '../src/nativeTransport';

afterEach(() => vi.resetAllMocks());
function socket() {
  let listener: (message: Message) => void = () => {};
  const unlisten = vi.fn();
  const value = { send: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), addListener: vi.fn((callback: typeof listener) => { listener = callback; return unlisten; }) };
  mocks.connect.mockResolvedValue(value);
  return { value, unlisten, receive: (message: Message) => listener(message) };
}
describe('native transport adapter', () => {
  it('uses manual cookies, preserves Cookie, suppresses WebView Origin and disables all redirects', async () => {
    mocks.fetch.mockResolvedValue(new Response('ok'));
    const options = nativeOptions();
    expect(options.cookieMode).toBe('manual');
    await options.fetch!('http://192.168.1.2:3077/connect?token=test', { redirect: 'manual', headers: { cookie: 'api=signed' } });
    const init = mocks.fetch.mock.calls[0]![1] as RequestInit & { maxRedirections: number };
    expect(init.maxRedirections).toBe(0);
    expect(new Headers(init.headers).get('cookie')).toBe('api=signed');
    expect(new Headers(init.headers).get('origin')).toBe('');
  });
  it('opens asynchronously with Cookie, orders writes, forwards text/close, and removes listeners', async () => {
    const mock = socket();
    const ws = new NativeSocket('ws://lan:3077/api/remote.mux', { cookie: 'api=signed' });
    const open = vi.fn(), message = vi.fn(), closed = vi.fn();
    ws.addEventListener('open', open, { once: true });
    ws.addEventListener('message', message);
    ws.addEventListener('close', closed);
    await vi.waitFor(() => expect(ws.readyState).toBe(1));
    expect(open).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith('ws://lan:3077/api/remote.mux', { headers: { cookie: 'api=signed' } });
    ws.send('first'); ws.send('second');
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
    const open = vi.fn(); ws.addEventListener('open', open);
    ws.close();
    await vi.waitFor(() => expect(mock.value.disconnect).toHaveBeenCalledOnce());
    expect(open).not.toHaveBeenCalled();
    expect(mock.value.addListener).not.toHaveBeenCalled();
  });
  it('reports connect and async write failures as socket errors', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('failed'));
    const ws = new NativeSocket('ws://host/api/remote.mux', {});
    const error = vi.fn(); ws.addEventListener('error', error);
    await vi.waitFor(() => expect(ws.readyState).toBe(3));
    expect(error).toHaveBeenCalledOnce();
    const mock = socket(); mock.value.send.mockRejectedValueOnce(new Error('send failed'));
    const writing = new NativeSocket('ws://host/api/remote.mux', {});
    writing.addEventListener('error', error);
    await vi.waitFor(() => expect(writing.readyState).toBe(1));
    writing.send('request');
    await vi.waitFor(() => expect(writing.readyState).toBe(3));
    expect(error).toHaveBeenCalledTimes(2);
  });
});
