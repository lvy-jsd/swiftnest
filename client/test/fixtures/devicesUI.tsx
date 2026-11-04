/** Deterministic API fixtures for the devices layout. Production never imports this module. */
import { createRoot } from 'react-dom/client';
import type { Device, LiveUpdate, LiveView, ScreenFrame, SwiftnestClient } from '@swiftnest/api';
import { ConnectionProvider, ConnectionStore, type ConnectionState } from '../../src/connection';
import { DeviceHubProvider, DevicesPage } from '../../src/devices';
import { ThemeProvider } from '../../src/design/theme';
import { I18nProvider } from '../../src/i18n';
import '@fontsource-variable/inter';
import '@fontsource-variable/noto-sans-sc';
import '../../src/styles.css';

const calls: unknown[] = [];
const devices: Device[] = [
  {
    device: 'phone',
    name: '我的手机',
    kind: 'android',
    online: true,
    paired: true,
    fingerprint: 'phone-fingerprint',
    capabilities: [{ id: 'screen', version: '1', tools: ['capture'] }],
  },
  {
    device: 'computer',
    name: '家里的电脑',
    kind: 'desktop',
    online: true,
    paired: true,
    fingerprint: 'computer-fingerprint',
    capabilities: [],
  },
  {
    device: 'offline',
    name: '办公室笔记本',
    kind: 'desktop',
    online: false,
    paired: true,
    fingerprint: 'offline-fingerprint',
    lastSeen: new Date(Date.now() - 7200_000).toISOString(),
    capabilities: [{ id: 'screen', version: '1', tools: ['capture'] }],
  },
];
let candidates = [{ id: 'candidate', device: '客厅的平板', fingerprint: 'aaaa-bbbb-cccc-dddd' }];
function screenFrame(): ScreenFrame {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1440;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#e4e8f5';
  ctx.fillRect(0, 0, 720, 1440);
  ctx.fillStyle = '#323750';
  ctx.font = '36px sans-serif';
  ctx.fillText('Screen stream fixture', 48, 100);
  for (let index = 0; index < 4; index++) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(36, 160 + index * 240, 648, 200);
    ctx.fillStyle = '#4b57d6';
    ctx.fillRect(64, 200 + index * 240, 100, 100);
  }
  return {
    captureId: 'frame',
    displayId: 'phone',
    width: 720,
    height: 1440,
    scaleFactor: 1,
    mime: 'image/jpeg',
    image: Uint8Array.from(atob(canvas.toDataURL('image/jpeg').split(',')[1]!), (c) => c.charCodeAt(0)),
  };
}
class LiveFixture {
  queue: LiveUpdate[] = [{ control: 'ivy', frame: screenFrame() }];
  stopped = false;
  wake?: () => void;
  push(update: LiveUpdate) {
    this.queue.push(update);
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (!this.stopped) {
      if (!this.queue.length)
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
      while (this.queue.length) yield this.queue.shift()!;
    }
  }
  async takeOver() {
    calls.push('take');
    this.push({ control: 'owner' });
  }
  async handBack() {
    calls.push('back');
    this.push({ control: 'ivy' });
  }
  async input(tool: string, args: unknown) {
    calls.push({ tool, args });
  }
  close() {
    calls.push('close');
    this.stopped = true;
    this.wake?.();
  }
}
const store = new ConnectionStore();
let state: ConnectionState = { status: 'connected', root: '', sessions: [] };
const subscribers = new Set<() => void>();
store.subscribe = (listener) => {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
};
store.getSnapshot = () => state;
store.updateDeviceContext = async () => {};
store.client = {
  listDevices: async () => devices,
  listDeviceApprovals: async () => [],
  listDevicePairings: async () => candidates,
  listTransfers: async () => [],
  watchDevices: async ({ signal }: { signal: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
    close() {},
  }),
  confirmDevicePairing: async (id: string, accept: boolean) => {
    calls.push({ pairing: id, accept });
    candidates = [];
  },
  createDevicePairing: async () => ({
    code: '482913',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    url: 'ws://localhost:7711/swiftnest',
    fingerprint: 'nest-fingerprint',
  }),
  openLiveView: async (device: string) => {
    calls.push({ open: device });
    return new LiveFixture() as unknown as LiveView;
  },
  close() {},
} as unknown as SwiftnestClient;
(window as any).__devicesUI = {
  calls,
  setConnection(connected: boolean) {
    state = { ...state, status: connected ? 'connected' : 'disconnected' };
    for (const notify of subscribers) notify();
  },
};
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <I18nProvider>
      <ConnectionProvider store={store}>
        <DeviceHubProvider>
          <DevicesPage onBack={() => calls.push('back-page')} />
        </DeviceHubProvider>
      </ConnectionProvider>
    </I18nProvider>
  </ThemeProvider>,
);
